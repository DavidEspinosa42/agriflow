import type { Snapshot } from "@agriflow/core";
import { describe, expect, it } from "vitest";
import { deviceHealth, formatAge, formatDateTime, formatLiters } from "./format.ts";
import { initialLocale, saveLocale } from "./locale.ts";
import { ApiError, ManagerApi } from "./manager-api.ts";
import { type ConnectionState, OperatorClient, type SocketLike } from "./operator-client.ts";

const idle: Snapshot = {
  phase: "idle",
  pumpOn: false,
  estopEngaged: false,
  operatorId: null,
  machineId: null,
  liters: 0,
  endReason: null,
  notice: { kind: "none" },
};

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onopen: ((event: never) => void) | null = null;
  onclose: ((event: never) => void) | null = null;
  onerror: ((event: never) => void) | null = null;
  onmessage: ((event: never) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.(undefined as never);
  }
  receive(data: unknown): void {
    this.onmessage?.({ data } as never);
  }
  drop(): void {
    this.onclose?.(undefined as never);
  }
}

function operatorSetup() {
  const sockets: FakeSocket[] = [];
  const snapshots: Snapshot[] = [];
  const states: ConnectionState[] = [];
  const timers: { callback: () => void; ms: number }[] = [];
  const client = new OperatorClient({
    url: "ws://127.0.0.1:4100/ws",
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onSnapshot: (s) => snapshots.push(s),
    onConnection: (s) => states.push(s),
    setTimer: (callback, ms) => {
      timers.push({ callback, ms });
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  return { client, sockets, snapshots, states, timers };
}

describe("OperatorClient", () => {
  it("delivers validated snapshots and ignores everything else", () => {
    const { client, sockets, snapshots } = operatorSetup();
    client.start();
    sockets[0]?.open();
    sockets[0]?.receive(JSON.stringify({ type: "state", snapshot: idle }));
    sockets[0]?.receive("not json");
    sockets[0]?.receive(JSON.stringify({ type: "state", snapshot: { ...idle, liters: -5 } }));
    sockets[0]?.receive(JSON.stringify({ type: "state", snapshot: { ...idle, uid: "04A1B2C3" } }));
    sockets[0]?.receive(new ArrayBuffer(4));
    expect(snapshots).toEqual([idle]);
  });

  it("sends only valid commands, and only while the connection is open", () => {
    const { client, sockets } = operatorSetup();
    client.start();
    expect(client.send({ type: "start" })).toBe(false);
    sockets[0]?.open();
    expect(client.send({ type: "start" })).toBe(true);
    expect(client.send({ type: "select_machine", equipmentNumber: "T-12" })).toBe(true);
    expect(client.send({ type: "scan", uid: "04A1B2C3" } as never)).toBe(false);
    expect(sockets[0]?.sent.map((s) => JSON.parse(s))).toEqual([
      { type: "start" },
      { type: "select_machine", equipmentNumber: "T-12" },
    ]);
  });

  it("reconnects with a growing, capped delay and resets after success", () => {
    const { client, sockets, states, timers } = operatorSetup();
    client.start();
    sockets[0]?.drop();
    expect(timers.map((t) => t.ms)).toEqual([1000]);
    timers[0]?.callback();
    sockets[1]?.drop();
    timers[1]?.callback();
    sockets[2]?.drop();
    timers[2]?.callback();
    sockets[3]?.drop();
    timers[3]?.callback();
    sockets[4]?.drop();
    expect(timers.map((t) => t.ms)).toEqual([1000, 2000, 4000, 5000, 5000]);
    timers[4]?.callback();
    sockets[5]?.open();
    sockets[5]?.drop();
    expect(timers.at(-1)?.ms).toBe(1000);
    expect(states).toContain("open");
    expect(states.at(-1)).toBe("closed");
  });

  it("stops for good when stopped", () => {
    const { client, sockets, timers, states } = operatorSetup();
    client.start();
    sockets[0]?.open();
    client.stop();
    expect(sockets[0]?.closed).toBe(true);
    expect(timers).toEqual([]);
    expect(states.at(-1)).toBe("closed");
    expect(client.send({ type: "stop" })).toBe(false);
  });
});

describe("ManagerApi", () => {
  const respond = (status: number, body: unknown) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const api = (fetch: ConstructorParameters<typeof ManagerApi>[0]["fetch"]) =>
    new ManagerApi({ baseUrl: "https://farm.example.com/", token: "t".repeat(20), fetch });

  it("sends the bearer token and builds the query string", async () => {
    let seen: { url: string; auth: string | undefined } | undefined;
    await api(async (url, init) => {
      seen = { url, auth: init.headers["authorization"] };
      return { ok: true, status: 200, json: async () => ({ groupBy: "day", rows: [] }) };
    }).consumption({ groupBy: "day", from: 1000, machineId: "T-12", to: undefined });
    expect(seen?.url).toBe(
      "https://farm.example.com/v1/reports/consumption?groupBy=day&from=1000&machineId=T-12",
    );
    expect(seen?.auth).toBe(`Bearer ${"t".repeat(20)}`);
  });

  it("returns validated bodies", async () => {
    const page = await api(
      respond(200, { items: [], total: 0, limit: 50, offset: 0 }),
    ).transactions();
    expect(page.total).toBe(0);
    expect(
      (
        await api(
          respond(200, {
            items: [{ deviceId: "p", tankId: "t", sessions: 1, lastReceivedAtMs: null }],
          }),
        ).devices()
      ).items,
    ).toHaveLength(1);
  });

  it("maps failures to error kinds without exposing server details", async () => {
    const kind = async (fetch: ConstructorParameters<typeof ManagerApi>[0]["fetch"]) => {
      try {
        await api(fetch).devices();
      } catch (error) {
        return error instanceof ApiError ? error.kind : "other";
      }
      return "none";
    };
    expect(await kind(respond(401, {}))).toBe("unauthorized");
    expect(await kind(respond(400, {}))).toBe("invalid_query");
    expect(await kind(respond(500, { error: "secret mysql://root:pw@host" }))).toBe("server");
    expect(await kind(respond(200, { items: [{ nope: true }] }))).toBe("invalid_response");
    expect(
      await kind(async () => {
        throw new TypeError("fetch failed");
      }),
    ).toBe("network");
    expect(
      await kind(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("bad json");
        },
      })),
    ).toBe("invalid_response");
  });
});

describe("format", () => {
  it("formats liters in the locale of the user", () => {
    expect(formatLiters(84.3, "es")).toBe("84,3 L");
    expect(formatLiters(1234.5, "es")).toMatch(/^1\.234,5 L$/);
    expect(formatLiters(84.3, "en")).toBe("84.3 L");
    expect(formatLiters(0, "es")).toBe("0,0 L");
  });

  it("formats times in the farm's time zone", () => {
    const ms = Date.UTC(2026, 2, 10, 1, 0);
    expect(formatDateTime(ms, "es", "America/Argentina/Buenos_Aires")).toContain("22:00");
    expect(formatDateTime(ms, "es", "UTC")).toContain("01:00");
  });

  it("formats elapsed time", () => {
    expect(formatAge(5_000)).toBe("<1 min");
    expect(formatAge(3 * 60_000)).toBe("3 min");
    expect(formatAge(2 * 3_600_000)).toBe("2 h");
    expect(formatAge(72 * 3_600_000)).toBe("3 d");
    expect(formatAge(-1000)).toBe("<1 min");
  });

  it("classifies device health without claiming a device is down", () => {
    expect(deviceHealth(null, 1000, 500)).toBe("never");
    expect(deviceHealth(900, 1000, 500)).toBe("ok");
    expect(deviceHealth(100, 1000, 500)).toBe("stale");
  });
});

describe("language choice", () => {
  const store = (value: string | null) => ({ getItem: () => value });
  it("defaults to English, honours the query, then the saved choice", () => {
    expect(initialLocale("", store(null))).toBe("en");
    expect(initialLocale("?lang=es", store("en"))).toBe("es");
    expect(initialLocale("", store("es"))).toBe("es");
    expect(initialLocale("", store("fr"))).toBe("en");
    expect(initialLocale("?lang=fr", store(null))).toBe("en");
  });
  it("survives storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(initialLocale("", broken)).toBe("en");
    expect(() => saveLocale("es", broken)).not.toThrow();
  });
});
