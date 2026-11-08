import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AuditEntry,
  appendAudit,
  appendSession,
  effectiveLiters,
  emptyLedger,
  type Ledger,
  LedgerError,
  type SessionRecord,
} from "./ledger.ts";
import type { SessionId } from "./schemas.ts";

const record = (sessionId: string, liters: number): SessionRecord =>
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
  }) as SessionRecord;

const correction = (entryId: string, sessionId: string, deltaLiters: number): AuditEntry =>
  ({
    entryId,
    kind: "correction",
    atMs: 5,
    sessionId,
    deltaLiters,
    reason: "meter_check",
  }) as AuditEntry;

const sessionArb = fc
  .tuple(fc.uuid(), fc.double({ min: 0, max: 600, noNaN: true }))
  .map(([id, liters]) => record(id, liters));

describe("ledger", () => {
  it("never alters earlier records when appending (invariant 2)", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(sessionArb, { selector: (r) => r.sessionId, maxLength: 20 }),
        (records) => {
          let ledger: Ledger = emptyLedger;
          for (const [i, r] of records.entries()) {
            const before = structuredClone(ledger.sessions);
            ledger = appendSession(ledger, r);
            expect(ledger.sessions.slice(0, i)).toEqual(before);
            expect(ledger.sessions[i]).toEqual(r);
          }
        },
      ),
    );
  });

  it("rejects finalizing the same session twice", () => {
    const r = record("123e4567-e89b-42d3-a456-426614174000", 10);
    const ledger = appendSession(emptyLedger, r);
    expect(() => appendSession(ledger, { ...r, liters: 11 })).toThrow(LedgerError);
    expect(ledger.sessions[0]?.liters).toBe(10);
  });

  it("freezes stored records", () => {
    const ledger = appendSession(emptyLedger, record("123e4567-e89b-42d3-a456-426614174000", 10));
    expect(Object.isFrozen(ledger.sessions[0])).toBe(true);
  });

  it("applies corrections as linked entries without touching the original", () => {
    fc.assert(
      fc.property(
        sessionArb,
        fc.array(fc.double({ min: -5, max: 5, noNaN: true }), { maxLength: 10 }),
        (r, deltas) => {
          let ledger = appendSession(emptyLedger, r);
          for (const [i, d] of deltas.entries()) {
            const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
            ledger = appendAudit(ledger, correction(id, r.sessionId, d));
          }
          expect(ledger.sessions[0]).toEqual(r);
          const expected = r.liters + deltas.reduce((a, b) => a + b, 0);
          expect(effectiveLiters(ledger, r.sessionId as SessionId)).toBeCloseTo(expected, 6);
        },
      ),
    );
  });

  it("rejects corrections for unknown sessions or without a delta", () => {
    expect(() =>
      appendAudit(
        emptyLedger,
        correction(
          "00000000-0000-4000-8000-000000000001",
          "123e4567-e89b-42d3-a456-426614174000",
          1,
        ),
      ),
    ).toThrow(LedgerError);
    const ledger = appendSession(emptyLedger, record("123e4567-e89b-42d3-a456-426614174000", 10));
    expect(() =>
      appendAudit(ledger, {
        entryId: "00000000-0000-4000-8000-000000000002",
        kind: "correction",
        atMs: 1,
        sessionId: "123e4567-e89b-42d3-a456-426614174000",
      } as AuditEntry),
    ).toThrow(LedgerError);
  });

  it("rejects free-text audit reasons", () => {
    for (const reason of ["Contact operator at user@example.com", "Juan Perez", "", "UPPER"]) {
      expect(() =>
        appendAudit(emptyLedger, {
          entryId: "00000000-0000-4000-8000-000000000004",
          kind: "fault",
          atMs: 1,
          reason,
        } as AuditEntry),
      ).toThrow();
    }
  });

  it("rejects duplicate audit entry ids", () => {
    const e: AuditEntry = {
      entryId: "00000000-0000-4000-8000-000000000003",
      kind: "boot",
      atMs: 1,
    };
    const ledger = appendAudit(emptyLedger, e);
    expect(() => appendAudit(ledger, e)).toThrow(LedgerError);
  });
});
