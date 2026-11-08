import type { SessionRecord } from "@agriflow/core";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryRepository } from "../db/repository.ts";
import { buildApp } from "./app.ts";

const TOKEN = "device-token-0123456789abcdef";
const S1 = "00000000-0000-4000-8000-000000000001";
const S2 = "00000000-0000-4000-8000-000000000002";

const record = (sessionId: string, liters = 10): SessionRecord =>
  ({
    sessionId,
    deviceId: "pump-01",
    tankId: "tank-1",
    operatorId: "op-1",
    machineId: "m1",
    startedAtMs: 1000,
    endedAtMs: 2000,
    liters,
    endReason: "operator_stop",
  }) as SessionRecord;

let repo: MemoryRepository;
let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  repo = new MemoryRepository();
  repo.addDevice({ deviceId: "pump-01", tankId: "tank-1" }, TOKEN);
  app = buildApp({ repository: repo, now: () => 5000 });
});

const post = (sessions: unknown[], headers: Record<string, string> = {}, deviceId = "pump-01") =>
  app.inject({
    method: "POST",
    url: "/v1/sync/sessions",
    headers: { authorization: `Bearer ${TOKEN}`, ...headers },
    payload: { deviceId, sessions },
  });

describe("POST /v1/sync/sessions", () => {
  it("rejects missing, malformed and unknown tokens", async () => {
    expect((await post([record(S1)], { authorization: "" })).statusCode).toBe(401);
    expect((await post([record(S1)], { authorization: "Basic abc" })).statusCode).toBe(401);
    expect(
      (await post([record(S1)], { authorization: "Bearer wrong-token-0123456789" })).statusCode,
    ).toBe(401);
    expect(repo.all()).toEqual([]);
  });

  it("stores a batch and acknowledges each session", async () => {
    const res = await post([record(S1), record(S2)]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      acks: [
        { sessionId: S1, status: "stored" },
        { sessionId: S2, status: "stored" },
      ],
    });
    expect(repo.all()).toHaveLength(2);
  });

  it("is idempotent: a replay is a duplicate and creates no second transaction", async () => {
    await post([record(S1)]);
    const again = await post([record(S1)]);
    expect(again.json()).toEqual({ acks: [{ sessionId: S1, status: "duplicate" }] });
    expect(repo.all()).toHaveLength(1);
  });

  it("reports a conflict and keeps the first record when content differs", async () => {
    await post([record(S1, 10)]);
    const res = await post([record(S1, 99)]);
    expect(res.json()).toEqual({ acks: [{ sessionId: S1, status: "conflict" }] });
    expect(repo.all()[0]?.liters).toBe(10);
  });

  it("rejects invalid bodies without storing anything", async () => {
    expect((await post([])).statusCode).toBe(400);
    expect((await post([{ ...record(S1), liters: -1 }])).statusCode).toBe(400);
    expect((await post([{ ...record(S1), extra: true }])).statusCode).toBe(400);
    expect(repo.all()).toEqual([]);
  });

  it("refuses sessions that belong to another device or tank", async () => {
    expect((await post([record(S1)], {}, "pump-02")).statusCode).toBe(403);
    expect((await post([{ ...record(S1), deviceId: "pump-02" }])).statusCode).toBe(403);
    expect((await post([{ ...record(S1), tankId: "tank-9" }])).statusCode).toBe(403);
    expect(repo.all()).toEqual([]);
  });

  it("does not leak internal errors", async () => {
    const failingRepo = new MemoryRepository();
    failingRepo.addDevice({ deviceId: "pump-01", tankId: "tank-1" }, TOKEN);
    failingRepo.storeBatch = async () => {
      throw new Error("secret connection string mysql://root:pw@host");
    };
    const failing = buildApp({ repository: failingRepo, now: () => 1 });
    const res = await failing.inject({
      method: "POST",
      url: "/v1/sync/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { deviceId: "pump-01", sessions: [record(S1)] },
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("secret");
  });

  it("serves health", async () => {
    expect((await app.inject("/v1/health")).json()).toEqual({ status: "ok" });
  });
});

describe("manager read API", () => {
  const MANAGER = "manager-token-0123456789abcdef";
  const get = (url: string, token: string | null = MANAGER) =>
    app.inject({
      method: "GET",
      url,
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });

  beforeEach(async () => {
    repo.addManager("mgr-1", MANAGER);
    await post([
      record(S1, 10),
      { ...record(S2, 5), machineId: "m2", operatorId: "op-2", startedAtMs: 3000 },
    ]);
  });

  it("requires a manager token; a device token is not enough", async () => {
    for (const url of [
      "/v1/transactions",
      "/v1/reports/consumption",
      "/v1/machines",
      "/v1/operators",
      "/v1/devices",
    ]) {
      expect((await get(url, null)).statusCode).toBe(401);
      expect((await get(url, "wrong-token-0123456789abcdef")).statusCode).toBe(401);
      expect((await get(url, TOKEN)).statusCode).toBe(401);
    }
  });

  it("lists transactions newest first with paging and filters", async () => {
    const all = (await get("/v1/transactions")).json();
    expect(all.total).toBe(2);
    expect(all.items.map((i: { sessionId: string }) => i.sessionId)).toEqual([S2, S1]);
    expect(all.items[0].receivedAtMs).toBe(5000);

    const page = (await get("/v1/transactions?limit=1&offset=1")).json();
    expect(page.items.map((i: { sessionId: string }) => i.sessionId)).toEqual([S1]);
    expect(page.total).toBe(2);

    const filtered = (await get("/v1/transactions?machineId=m2")).json();
    expect(filtered.items).toHaveLength(1);
  });

  it("reports consumption grouped by day, machine and operator", async () => {
    const byMachine = (await get("/v1/reports/consumption?groupBy=machine")).json();
    expect(byMachine).toEqual({
      groupBy: "machine",
      rows: [
        { key: "m1", liters: 10, sessions: 1 },
        { key: "m2", liters: 5, sessions: 1 },
      ],
    });
    const byDay = (await get("/v1/reports/consumption")).json();
    expect(byDay.groupBy).toBe("day");
    expect(byDay.rows).toEqual([{ key: "1969-12-31", liters: 15, sessions: 2 }]);
    const local = (await get("/v1/reports/consumption?utcOffsetMinutes=0")).json();
    expect(local.rows).toEqual([{ key: "1970-01-01", liters: 15, sessions: 2 }]);
  });

  it("lists machines, operators and device status", async () => {
    expect((await get("/v1/machines")).json().items.map((i: { key: string }) => i.key)).toEqual([
      "m1",
      "m2",
    ]);
    expect((await get("/v1/operators")).json().items).toHaveLength(2);
    expect((await get("/v1/devices")).json().items).toEqual([
      { deviceId: "pump-01", tankId: "tank-1", sessions: 2, lastReceivedAtMs: 5000 },
    ]);
  });

  it("rejects unknown or out-of-range query parameters", async () => {
    for (const url of [
      "/v1/transactions?limit=0",
      "/v1/transactions?limit=1000",
      "/v1/transactions?offset=-1",
      "/v1/transactions?bogus=1",
      "/v1/transactions?from=abc",
      "/v1/reports/consumption?groupBy=tank",
      "/v1/reports/consumption?utcOffsetMinutes=9999",
      "/v1/machines?machineId=x",
    ]) {
      expect((await get(url)).statusCode, url).toBe(400);
    }
  });
});
