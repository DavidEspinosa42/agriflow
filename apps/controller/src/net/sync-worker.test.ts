import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "@agriflow/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../storage/database.ts";
import { ControllerStore } from "../storage/store.ts";
import { type Fetch, SyncWorker } from "./sync-worker.ts";

const S1 = "00000000-0000-4000-8000-000000000001";
const S2 = "00000000-0000-4000-8000-000000000002";

const record = (sessionId: string): SessionRecord =>
  ({
    sessionId,
    deviceId: "pump-01",
    tankId: "tank-1",
    operatorId: "op-1",
    machineId: "m1",
    startedAtMs: 1000,
    endedAtMs: 2000,
    liters: 10,
    endReason: "operator_stop",
  }) as SessionRecord;

let dir: string;
let now: number;
let db: ReturnType<typeof openDatabase>;
let store: ControllerStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agriflow-sync-"));
  db = openDatabase(join(dir, "c.db"));
  store = new ControllerStore(db);
  now = 1_000_000;
  store.finalizeSession(record(S1), now);
  store.finalizeSession(record(S2), now);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

function worker(fetch: Fetch) {
  return new SyncWorker({
    store,
    deviceId: "pump-01",
    serverUrl: "http://server.test/",
    token: "secret-token",
    now: () => now,
    random: () => 0.5,
    fetch,
  });
}

const statuses = () => store.listOutbox().map((e) => [e.sessionId, e.status] as const);

describe("SyncWorker", () => {
  it("does nothing when there is nothing to send", async () => {
    const emptyDb = openDatabase(join(dir, "empty.db"));
    const idle = new SyncWorker({
      store: new ControllerStore(emptyDb),
      deviceId: "pump-01",
      serverUrl: "http://x",
      token: "t",
      now: () => now,
      fetch: async () => {
        throw new Error("should not be called");
      },
    });
    expect(await idle.runOnce()).toEqual({ kind: "idle" });
    emptyDb.close();
  });

  it("sends the batch with the device token and marks acknowledged sessions", async () => {
    let seen: { url: string; auth: string | null; count: number } | undefined;
    const w = worker(async (url, init) => {
      seen = {
        url,
        auth: new Headers(init.headers).get("authorization"),
        count: JSON.parse(String(init.body)).sessions.length,
      };
      return json({
        acks: [
          { sessionId: S1, status: "stored" },
          { sessionId: S2, status: "duplicate" },
        ],
      });
    });
    expect(await w.runOnce()).toEqual({ kind: "synced", sent: 2, acked: 2 });
    expect(seen).toEqual({
      url: "http://server.test/v1/sync/sessions",
      auth: "Bearer secret-token",
      count: 2,
    });
    expect(statuses().every(([, s]) => s === "acked")).toBe(true);
    expect(await w.runOnce()).toEqual({ kind: "idle" });
  });

  it("keeps sessions pending and backs off when offline, then recovers (invariant 3)", async () => {
    const down = worker(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await down.runOnce()).toEqual({ kind: "failed", sent: 2, reason: "network" });
    expect(statuses().every(([, s]) => s === "pending")).toBe(true);
    const [first] = store.listOutbox();
    expect(first?.attempts).toBe(1);
    expect(first?.nextAttemptAtMs).toBeGreaterThan(now);
    // Not due yet: nothing is sent.
    expect(await down.runOnce()).toEqual({ kind: "idle" });

    now = (first?.nextAttemptAtMs ?? 0) + 1;
    const up = worker(async () =>
      json({
        acks: [
          { sessionId: S1, status: "stored" },
          { sessionId: S2, status: "stored" },
        ],
      }),
    );
    expect((await up.runOnce()).kind).toBe("synced");
    expect(statuses().every(([, s]) => s === "acked")).toBe(true);
  });

  it("treats server errors and malformed responses as failures", async () => {
    expect(await worker(async () => json({}, 500)).runOnce()).toMatchObject({
      reason: "http_500",
    });
    now += 3_600_000;
    expect(await worker(async () => json({ nope: true })).runOnce()).toMatchObject({
      reason: "invalid_response",
    });
    expect(statuses().every(([, s]) => s === "pending")).toBe(true);
  });

  it("ignores acks for sessions it did not send and retries unacknowledged ones", async () => {
    const other = "00000000-0000-4000-8000-0000000000ff";
    const w = worker(async () =>
      json({
        acks: [
          { sessionId: S1, status: "stored" },
          { sessionId: other, status: "stored" },
        ],
      }),
    );
    expect(await w.runOnce()).toEqual({ kind: "synced", sent: 2, acked: 1 });
    expect(statuses()).toEqual(
      expect.arrayContaining([
        [S1, "acked"],
        [S2, "pending"],
      ]),
    );
    expect(store.listOutbox().find((e) => e.sessionId === S2)?.attempts).toBe(1);
  });

  it("records a conflict without retrying it", async () => {
    const w = worker(async () =>
      json({
        acks: [
          { sessionId: S1, status: "conflict" },
          { sessionId: S2, status: "stored" },
        ],
      }),
    );
    await w.runOnce();
    expect(statuses()).toEqual(
      expect.arrayContaining([
        [S1, "conflict"],
        [S2, "acked"],
      ]),
    );
  });
});
