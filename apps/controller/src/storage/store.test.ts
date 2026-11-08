import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEntry, Credential, Machine, SessionRecord, SyncAck } from "@agriflow/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, schemaVersion } from "./database.ts";
import { migrations } from "./migrations.ts";
import { ControllerStore } from "./store.ts";

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

const open = (liters: number, at = 1500) => ({
  sessionId: S1 as SessionRecord["sessionId"],
  operatorId: "op-1" as SessionRecord["operatorId"],
  machineId: "m1" as SessionRecord["machineId"],
  startedAtMs: 1000,
  lastCheckpointAtMs: at,
  liters,
});

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agriflow-"));
  path = join(dir, "controller.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function withStore<T>(work: (store: ControllerStore) => T): T {
  const db = openDatabase(path);
  try {
    return work(new ControllerStore(db));
  } finally {
    db.close();
  }
}

describe("database", () => {
  it("applies migrations once and is safe to reopen", () => {
    const db = openDatabase(path);
    expect(schemaVersion(db)).toBe(migrations.length);
    db.close();
    const again = openDatabase(path);
    expect(schemaVersion(again)).toBe(migrations.length);
    again.close();
  });

  it("uses WAL with full synchronous durability", () => {
    const db = openDatabase(path);
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe(
      "wal",
    );
    expect((db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous).toBe(2);
    db.close();
  });
});

describe("append-only ledger (invariant 2)", () => {
  it("refuses to update or delete finalized sessions and audit events", () => {
    const db = openDatabase(path);
    const store = new ControllerStore(db);
    store.finalizeSession(record(S1), 0);
    store.appendAudit({ entryId: "00000000-0000-4000-8000-0000000000a1", kind: "boot", atMs: 1 });
    expect(() => db.exec("UPDATE sessions SET liters = 99")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM sessions")).toThrow(/append-only/);
    expect(() => db.exec("UPDATE audit_events SET reason = 'x'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM audit_events")).toThrow(/append-only/);
    expect(store.findSession(S1)?.liters).toBe(10);
    db.close();
  });

  it("records corrections as linked audit entries and rejects orphans", () => {
    withStore((store) => {
      store.finalizeSession(record(S1), 0);
      const fix: AuditEntry = {
        entryId: "00000000-0000-4000-8000-0000000000b1",
        kind: "correction",
        atMs: 5,
        sessionId: S1 as AuditEntry["sessionId"],
        deltaLiters: -0.5,
        reason: "meter_check",
      };
      store.appendAudit(fix);
      expect(store.listAudit()).toEqual([fix]);
      expect(store.findSession(S1)?.liters).toBe(10);
      expect(() =>
        store.appendAudit({
          ...fix,
          entryId: "00000000-0000-4000-8000-0000000000b2",
          sessionId: S2 as AuditEntry["sessionId"],
        }),
      ).toThrow();
    });
  });

  it("rolls back finalization when the session already exists", () => {
    withStore((store) => {
      store.checkpoint(open(5));
      store.finalizeSession(record(S1), 0);
      store.checkpoint(open(6));
      expect(() => store.finalizeSession(record(S1, 77), 0)).toThrow();
      expect(store.findSession(S1)?.liters).toBe(10);
      expect(store.listOutbox()).toHaveLength(1);
      expect(store.findOpenSession()?.liters).toBe(6);
    });
  });
});

describe("hardening", () => {
  it("blocks INSERT OR REPLACE from overwriting finalized rows", () => {
    const db = openDatabase(path);
    const store = new ControllerStore(db);
    store.finalizeSession(record(S1), 0);
    expect(() =>
      db.exec(
        `INSERT OR REPLACE INTO sessions VALUES ('${S1}', 'pump-01', 'tank-1', 'op-1', 'm1', 1, 2, 99, 'operator_stop')`,
      ),
    ).toThrow(/append-only/);
    db.exec(
      `INSERT INTO audit_events (entry_id, kind, at_ms) VALUES ('00000000-0000-4000-8000-0000000000c1', 'boot', 1)`,
    );
    expect(() =>
      db.exec(
        `INSERT OR REPLACE INTO audit_events (entry_id, kind, at_ms) VALUES ('00000000-0000-4000-8000-0000000000c1', 'fault', 2)`,
      ),
    ).toThrow(/append-only/);
    expect(store.findSession(S1)?.liters).toBe(10);
    db.close();
  });

  it("rejects non-finite or negative checkpoint liters", () => {
    withStore((store) => {
      for (const liters of [Number.POSITIVE_INFINITY, Number.NaN, -1]) {
        expect(() => store.checkpoint(open(liters))).toThrow();
      }
      expect(store.findOpenSession()).toBeNull();
    });
  });

  it("rejects a malformed ack batch without changing any entry", () => {
    withStore((store) => {
      store.finalizeSession(record(S1), 0);
      store.finalizeSession(record(S2), 0);
      const bad = [
        { sessionId: S1, status: "stored" },
        { sessionId: S2, status: "bogus" },
      ] as unknown as SyncAck[];
      expect(() => store.applyAcks(bad)).toThrow();
      expect(store.listOutbox().every((e) => e.status === "pending")).toBe(true);
    });
  });
});

describe("transactions", () => {
  it("composes transactional methods and rolls everything back on failure", () => {
    withStore((store) => {
      expect(() =>
        store.transaction(() => {
          store.finalizeSession(record(S1), 0);
          store.appendAudit({
            entryId: "00000000-0000-4000-8000-0000000000d1",
            kind: "session_finalized",
            atMs: 1,
            sessionId: S1 as AuditEntry["sessionId"],
          });
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(store.listSessions()).toEqual([]);
      expect(store.listAudit()).toEqual([]);
      store.transaction(() => {
        store.finalizeSession(record(S1), 0);
        store.appendAudit({
          entryId: "00000000-0000-4000-8000-0000000000d2",
          kind: "session_finalized",
          atMs: 1,
          sessionId: S1 as AuditEntry["sessionId"],
        });
      });
      expect(store.listSessions()).toHaveLength(1);
      expect(store.listAudit()).toHaveLength(1);
    });
  });

  it("rolls back only the inner work when an inner failure is caught", () => {
    withStore((store) => {
      store.transaction(() => {
        store.finalizeSession(record(S1), 0);
        expect(() => store.finalizeSession(record(S1, 5), 0)).toThrow();
      });
      expect(store.findSession(S1)?.liters).toBe(10);
    });
  });

  it("rejects asynchronous callbacks and rolls back", () => {
    withStore((store) => {
      expect(() =>
        store.transaction((() => {
          store.setSetting("maxSessionLiters", 250);
          return Promise.resolve();
        }) as () => void),
      ).toThrow(/synchronous/);
      expect(store.getSettings().maxSessionLiters).toBe(600);
    });
  });

  it("checks the matching session checkpoint even when a newer one exists", () => {
    withStore((store) => {
      store.checkpoint(open(20));
      store.checkpoint({
        ...open(1, 1800),
        sessionId: S2 as SessionRecord["sessionId"],
        startedAtMs: 1700,
      });
      expect(() => store.finalizeSession(record(S1, 10), 0)).toThrow(/durable checkpoint/);
      expect(store.findSession(S1)).toBeUndefined();
    });
  });

  it("refuses to finalize below the durable checkpoint", () => {
    withStore((store) => {
      store.checkpoint(open(20));
      expect(() => store.finalizeSession(record(S1, 15), 0)).toThrow(/durable checkpoint/);
      expect(store.findSession(S1)).toBeUndefined();
      expect(store.findOpenSession()?.liters).toBe(20);
      store.finalizeSession(record(S1, 20), 0);
      expect(store.findSession(S1)?.liters).toBe(20);
    });
  });
});

describe("durability (invariant 2)", () => {
  it("keeps a checkpoint across a reopen, as after a power cut", () => {
    withStore((store) => store.checkpoint(open(12.5)));
    withStore((store) => {
      expect(store.findOpenSession()).toMatchObject({ sessionId: S1, liters: 12.5 });
    });
  });

  it("never lowers checkpointed liters or the checkpoint time", () => {
    withStore((store) => {
      store.checkpoint(open(20, 2000));
      store.checkpoint(open(15, 1500));
      expect(store.findOpenSession()?.liters).toBe(20);
      expect(store.findOpenSession()?.lastCheckpointAtMs).toBe(2000);
    });
  });

  it("finalization clears the open session and queues the outbox in one step", () => {
    withStore((store) => {
      store.checkpoint(open(10));
      store.finalizeSession(record(S1), 4242);
      expect(store.findOpenSession()).toBeNull();
      expect(store.listOutbox()).toEqual([
        { sessionId: S1, status: "pending", attempts: 0, nextAttemptAtMs: 4242 },
      ]);
    });
  });
});

describe("outbox (invariant 3)", () => {
  it("moves pending to acked only on acknowledgment and never reverts", () => {
    withStore((store) => {
      store.finalizeSession(record(S1), 0);
      store.finalizeSession(record(S2), 0);
      store.applyAcks([{ sessionId: S1 as SessionRecord["sessionId"], status: "stored" }]);
      store.applyAcks([{ sessionId: S1 as SessionRecord["sessionId"], status: "conflict" }]);
      const byId = Object.fromEntries(store.listOutbox().map((e) => [e.sessionId, e.status]));
      expect(byId).toEqual({ [S1]: "acked", [S2]: "pending" });
    });
  });

  it("records failed attempts while staying pending", () => {
    withStore((store) => {
      store.finalizeSession(record(S1), 0);
      store.recordFailure(S1, 1, 9000);
      expect(store.listOutbox()[0]).toMatchObject({
        status: "pending",
        attempts: 1,
        nextAttemptAtMs: 9000,
      });
    });
  });
});

describe("reference data and settings", () => {
  it("round-trips credentials and machines", () => {
    withStore((store) => {
      const credential: Credential = {
        credentialRef: "a".repeat(64) as Credential["credentialRef"],
        operatorId: "op-7" as Credential["operatorId"],
        machineAccess: ["m1"] as Credential["machineAccess"],
        expiresAtMs: null,
        revoked: false,
      };
      const machine: Machine = {
        machineId: "m1" as Machine["machineId"],
        equipmentNumber: "T-12",
        active: true,
      };
      store.upsertCredential(credential);
      store.upsertMachine(machine);
      expect(store.findCredential(credential.credentialRef)).toEqual(credential);
      expect(store.findMachineByEquipmentNumber("T-12")).toEqual(machine);
      expect(store.findMachineByEquipmentNumber("t-12")).toEqual(machine);
      expect(() =>
        store.upsertMachine({ machineId: "m9", equipmentNumber: "t-12", active: true } as Machine),
      ).toThrow();
      expect(store.findCredential("b".repeat(64))).toBeUndefined();
      store.upsertCredential({ ...credential, revoked: true });
      expect(store.findCredential(credential.credentialRef)?.revoked).toBe(true);
    });
  });

  it("applies validated setting overrides on top of defaults", () => {
    withStore((store) => {
      expect(store.getSettings().maxSessionLiters).toBe(600);
      store.setSetting("maxSessionLiters", 250);
      expect(store.getSettings().maxSessionLiters).toBe(250);
      expect(() => store.setSetting("maxSessionLiters", -1)).toThrow();
      expect(() => store.setSetting("nope", 1)).toThrow();
      expect(store.getSettings().maxSessionLiters).toBe(250);
    });
  });
});
