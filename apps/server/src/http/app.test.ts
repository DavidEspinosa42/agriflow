import type { SessionRecord } from "@agriflow/core";
import { beforeEach, describe, expect, it } from "vitest";
import { MemorySyncRepository } from "../db/repository.ts";
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

let repo: MemorySyncRepository;
let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  repo = new MemorySyncRepository();
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
    const failing = buildApp({
      repository: {
        findDeviceByTokenHash: async () => ({ deviceId: "pump-01", tankId: "tank-1" }),
        storeBatch: async () => {
          throw new Error("secret connection string mysql://root:pw@host");
        },
      },
      now: () => 1,
    });
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
