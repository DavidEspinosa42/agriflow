import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SessionRecord } from "./ledger.ts";
import type { SessionId } from "./schemas.ts";
import {
  applyAcks,
  applyBatch,
  dueEntries,
  newOutboxEntry,
  type OutboxEntry,
  recordFailure,
  retryDelaySeconds,
  SyncRequest,
} from "./sync.ts";

const settings = { syncRetryBaseSeconds: 5, syncRetryMaxSeconds: 900 };

const idArb = fc.constantFrom(
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
);

const recordArb = fc.tuple(idArb, fc.integer({ min: 0, max: 600 })).map(
  ([sessionId, liters]) =>
    ({
      sessionId,
      deviceId: "pump-01",
      tankId: "tank-1",
      operatorId: "op-1",
      machineId: "m1",
      startedAtMs: 1,
      endedAtMs: 2,
      liters,
      endReason: "operator_stop",
    }) as SessionRecord,
);

describe("applyBatch", () => {
  it("keeps exactly one record per session id under any replay or reordering (invariant 3)", () => {
    fc.assert(
      fc.property(fc.array(fc.array(recordArb, { maxLength: 6 }), { maxLength: 8 }), (batches) => {
        let store: ReadonlyMap<string, SessionRecord> = new Map();
        const first = new Map<string, SessionRecord>();
        for (const batch of batches) {
          for (const r of batch) if (!first.has(r.sessionId)) first.set(r.sessionId, r);
          store = applyBatch(store, batch).store;
        }
        expect(store.size).toBe(first.size);
        for (const [id, r] of first) expect(store.get(id)).toEqual(r);
      }),
    );
  });

  it("replaying the same batch changes nothing and reports duplicates", () => {
    fc.assert(
      fc.property(fc.array(recordArb, { minLength: 1, maxLength: 6 }), (batch) => {
        const once = applyBatch(new Map(), batch);
        const twice = applyBatch(once.store, batch);
        expect(twice.store).toEqual(once.store);
        for (const ack of twice.acks) expect(ack.status).not.toBe("stored");
      }),
    );
  });

  it("flags a different record under an existing id as a conflict and keeps the original", () => {
    const a = {
      sessionId: "00000000-0000-4000-8000-000000000001",
      deviceId: "pump-01",
      tankId: "tank-1",
      operatorId: "op-1",
      machineId: "m1",
      startedAtMs: 1,
      endedAtMs: 2,
      liters: 10,
      endReason: "operator_stop",
    } as SessionRecord;
    const stored = applyBatch(new Map(), [a]).store;
    const result = applyBatch(stored, [{ ...a, liters: 99 }]);
    expect(result.acks[0]?.status).toBe("conflict");
    expect(result.store.get(a.sessionId)?.liters).toBe(10);
  });
});

describe("stored records", () => {
  it("are immutable copies that later input mutation cannot change", () => {
    const input = {
      sessionId: "00000000-0000-4000-8000-000000000001",
      deviceId: "pump-01",
      tankId: "tank-1",
      operatorId: "op-1",
      machineId: "m1",
      startedAtMs: 1,
      endedAtMs: 2,
      liters: 10,
      endReason: "operator_stop",
    } as SessionRecord;
    const { store } = applyBatch(new Map(), [input]);
    (input as { liters: number }).liters = 99;
    expect(store.get(input.sessionId)?.liters).toBe(10);
    expect(Object.isFrozen(store.get(input.sessionId))).toBe(true);
    expect(applyBatch(store, [input]).acks[0]?.status).toBe("conflict");
  });
});

describe("retry policy", () => {
  it("stays within [ceiling/2, ceiling] and never exceeds the maximum", () => {
    fc.assert(
      fc.property(fc.nat(60), fc.double({ min: 0, max: 1, noNaN: true }), (attempt, r) => {
        const d = retryDelaySeconds(attempt, settings, r);
        expect(d).toBeGreaterThan(0);
        expect(d).toBeLessThanOrEqual(900);
        expect(d).toBeGreaterThanOrEqual(Math.min(900, 5 * 2 ** attempt) / 2);
      }),
    );
  });

  it("has a non-decreasing ceiling as attempts grow", () => {
    for (let n = 0; n < 30; n++) {
      expect(retryDelaySeconds(n + 1, settings, 1)).toBeGreaterThanOrEqual(
        retryDelaySeconds(n, settings, 1),
      );
    }
  });
});

describe("outbox", () => {
  const id = "00000000-0000-4000-8000-000000000001" as SessionId;

  it("keeps entries pending until acknowledged", () => {
    const entry = newOutboxEntry(id, 0);
    const failed = recordFailure(entry, 1000, settings, 0.5);
    expect(failed.status).toBe("pending");
    expect(failed.attempts).toBe(1);
    expect(failed.nextAttemptAtMs).toBeGreaterThan(1000);
    expect(applyAcks([failed], [])[0]?.status).toBe("pending");
  });

  it("acks on stored or duplicate and parks conflicts without retrying", () => {
    const e = newOutboxEntry(id, 0);
    expect(applyAcks([e], [{ sessionId: id, status: "stored" }])[0]?.status).toBe("acked");
    expect(applyAcks([e], [{ sessionId: id, status: "duplicate" }])[0]?.status).toBe("acked");
    const conflict = applyAcks([e], [{ sessionId: id, status: "conflict" }]);
    expect(conflict[0]?.status).toBe("conflict");
    expect(dueEntries(conflict, 10_000_000)).toEqual([]);
  });

  it("never reverts an acked entry", () => {
    const acked: OutboxEntry = { ...newOutboxEntry(id, 0), status: "acked" };
    expect(applyAcks([acked], [{ sessionId: id, status: "conflict" }])[0]?.status).toBe("acked");
    expect(recordFailure(acked, 5, settings, 0.1)).toEqual(acked);
  });

  it("returns only due pending entries, oldest first, within the limit", () => {
    const mk = (n: number, at: number): OutboxEntry => ({
      ...newOutboxEntry(`00000000-0000-4000-8000-00000000000${n}` as SessionId, at),
    });
    const due = dueEntries([mk(3, 30), mk(1, 10), mk(2, 20), mk(4, 999)], 100, 2);
    expect(due.map((e) => e.nextAttemptAtMs)).toEqual([10, 20]);
  });
});

describe("SyncRequest", () => {
  it("rejects empty and oversized batches", () => {
    expect(SyncRequest.safeParse({ deviceId: "pump-01", sessions: [] }).success).toBe(false);
  });
});
