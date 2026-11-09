import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  type AuditEntry,
  AuditEntry as AuditEntrySchema,
  type Credential,
  Credential as CredentialSchema,
  type Machine,
  MachineId,
  Machine as MachineSchema,
  OperatorId,
  type OutboxEntry,
  type PersistedOpenSession,
  resolveSettings,
  SessionId,
  type SessionRecord,
  SessionRecord as SessionRecordSchema,
  type Settings,
  type SyncAck,
  SyncAck as SyncAckSchema,
  TimestampMs,
} from "@agriflow/core";

import { z } from "zod";

const OpenSession = z.strictObject({
  sessionId: SessionId,
  operatorId: OperatorId,
  machineId: MachineId,
  startedAtMs: TimestampMs,
  lastCheckpointAtMs: TimestampMs,
  liters: z.number().finite().nonnegative(),
});

type Row = Record<string, SQLInputValue>;

function isThenable(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function bool(value: SQLInputValue): boolean {
  return value === 1;
}

/** Typed access to the controller database. All inputs are validated with the core schemas. */
export class ControllerStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  #depth = 0;

  /**
   * Run `work` atomically. The outermost call is one IMMEDIATE transaction; nested calls use
   * savepoints, so store methods that are themselves transactional can be grouped safely.
   */
  transaction<T>(work: () => T): T {
    const outermost = this.#depth === 0;
    const savepoint = `sp_${this.#depth}`;
    this.#db.exec(outermost ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.#depth++;
    try {
      const result = work();
      if (isThenable(result)) {
        throw new TypeError("transaction callbacks must be synchronous");
      }
      this.#db.exec(outermost ? "COMMIT" : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      if (outermost) {
        this.#db.exec("ROLLBACK");
      } else {
        this.#db.exec(`ROLLBACK TO ${savepoint}`);
        this.#db.exec(`RELEASE ${savepoint}`);
      }
      throw error;
    } finally {
      this.#depth--;
    }
  }

  // --- settings ---------------------------------------------------------------------------

  getSettings(): Settings {
    const rows = this.#db.prepare("SELECT key, value FROM settings").all() as Row[];
    const overrides = Object.fromEntries(
      rows.map((r) => [r["key"], JSON.parse(String(r["value"]))]),
    );
    return resolveSettings(overrides);
  }

  setSetting(key: string, value: unknown): void {
    const next = { ...this.getSettings(), [key]: value };
    resolveSettings(next); // validate before persisting
    this.#db
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, JSON.stringify(value));
  }

  // --- reference data ---------------------------------------------------------------------

  upsertCredential(input: Credential): void {
    const c = CredentialSchema.parse(input);
    this.transaction(() => {
      this.#db
        .prepare("INSERT OR IGNORE INTO operators (operator_id) VALUES (?)")
        .run(c.operatorId);
      this.#db
        .prepare(
          `INSERT INTO credentials (credential_ref, operator_id, machine_access, expires_at_ms, revoked)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(credential_ref) DO UPDATE SET
             operator_id = excluded.operator_id,
             machine_access = excluded.machine_access,
             expires_at_ms = excluded.expires_at_ms,
             revoked = excluded.revoked`,
        )
        .run(
          c.credentialRef,
          c.operatorId,
          JSON.stringify(c.machineAccess),
          c.expiresAtMs,
          c.revoked ? 1 : 0,
        );
    });
  }

  findCredential(credentialRef: string): Credential | undefined {
    const row = this.#db
      .prepare("SELECT * FROM credentials WHERE credential_ref = ?")
      .get(credentialRef) as Row | undefined;
    if (row === undefined) return undefined;
    return CredentialSchema.parse({
      credentialRef: row["credential_ref"],
      operatorId: row["operator_id"],
      machineAccess: JSON.parse(String(row["machine_access"])),
      expiresAtMs: row["expires_at_ms"],
      revoked: bool(row["revoked"] ?? 0),
    });
  }

  upsertMachine(input: Machine): void {
    const m = MachineSchema.parse(input);
    this.#db
      .prepare(
        `INSERT INTO machines (machine_id, equipment_number, active) VALUES (?, ?, ?)
         ON CONFLICT(machine_id) DO UPDATE SET
           equipment_number = excluded.equipment_number, active = excluded.active`,
      )
      .run(m.machineId, m.equipmentNumber, m.active ? 1 : 0);
  }

  findMachineByEquipmentNumber(equipmentNumber: string): Machine | undefined {
    const row = this.#db
      // Equipment numbers are matched ignoring case: the kiosk keypad has no lowercase keys.
      .prepare("SELECT * FROM machines WHERE upper(equipment_number) = upper(?)")
      .get(equipmentNumber) as Row | undefined;
    if (row === undefined) return undefined;
    return MachineSchema.parse({
      machineId: row["machine_id"],
      equipmentNumber: row["equipment_number"],
      active: bool(row["active"] ?? 0),
    });
  }

  /** The current equipment number of a machine, for display. */
  equipmentNumberOf(machineId: string): string | undefined {
    const row = this.#db
      .prepare("SELECT equipment_number FROM machines WHERE machine_id = ?")
      .get(machineId) as Row | undefined;
    return row === undefined ? undefined : String(row["equipment_number"]);
  }

  // --- running session --------------------------------------------------------------------

  /** Durably record progress. Called at every state change and every checkpoint interval. */
  checkpoint(input: PersistedOpenSession): void {
    const open = OpenSession.parse(input);
    this.#db
      .prepare(
        `INSERT INTO open_sessions
           (session_id, operator_id, machine_id, started_at_ms, last_checkpoint_at_ms, liters)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           last_checkpoint_at_ms = MAX(open_sessions.last_checkpoint_at_ms, excluded.last_checkpoint_at_ms),
           liters = MAX(open_sessions.liters, excluded.liters)`,
      )
      .run(
        open.sessionId,
        open.operatorId,
        open.machineId,
        open.startedAtMs,
        open.lastCheckpointAtMs,
        open.liters,
      );
  }

  /** Remove a running-session row that never dispensed. Rows with delivered liters are kept. */
  discardUnstartedSession(sessionId: string): void {
    this.#db
      .prepare("DELETE FROM open_sessions WHERE session_id = ? AND liters = 0")
      .run(sessionId);
  }

  /** The unfinished session left by a crash or power cut, if any. */
  findOpenSession(): PersistedOpenSession | null {
    const row = this.#db
      .prepare("SELECT * FROM open_sessions ORDER BY started_at_ms DESC LIMIT 1")
      .get() as Row | undefined;
    if (row === undefined) return null;
    return {
      sessionId: String(row["session_id"]),
      operatorId: String(row["operator_id"]),
      machineId: String(row["machine_id"]),
      startedAtMs: Number(row["started_at_ms"]),
      lastCheckpointAtMs: Number(row["last_checkpoint_at_ms"]),
      liters: Number(row["liters"]),
    } as PersistedOpenSession;
  }

  /**
   * Finalize a session atomically: append the immutable record, queue it for sync and clear the
   * running-session row. Either all three happen or none do.
   */
  finalizeSession(record: SessionRecord, nowMs: number): void {
    const r = SessionRecordSchema.parse(record);
    this.transaction(() => {
      const checkpointed = this.#db
        .prepare("SELECT liters FROM open_sessions WHERE session_id = ?")
        .get(r.sessionId) as Row | undefined;
      if (checkpointed !== undefined && Number(checkpointed["liters"]) > r.liters) {
        throw new Error("final liters are below the durable checkpoint; refusing to lose progress");
      }
      this.#db
        .prepare(
          `INSERT INTO sessions
             (session_id, device_id, tank_id, operator_id, machine_id,
              equipment_number, started_at_ms, ended_at_ms, liters, end_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.sessionId,
          r.deviceId,
          r.tankId,
          r.operatorId,
          r.machineId,
          r.equipmentNumber ?? this.equipmentNumberOf(r.machineId) ?? null,
          r.startedAtMs,
          r.endedAtMs,
          r.liters,
          r.endReason,
        );
      this.#db
        .prepare(
          "INSERT INTO sync_outbox (session_id, status, attempts, next_attempt_at_ms) VALUES (?, 'pending', 0, ?)",
        )
        .run(r.sessionId, nowMs);
      this.#db.prepare("DELETE FROM open_sessions WHERE session_id = ?").run(r.sessionId);
    });
  }

  findSession(sessionId: string): SessionRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as
      | Row
      | undefined;
    return row === undefined ? undefined : this.#toSession(row);
  }

  listSessions(): SessionRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM sessions ORDER BY started_at_ms, session_id")
      .all() as Row[];
    return rows.map((row) => this.#toSession(row));
  }

  #toSession(row: Row): SessionRecord {
    return SessionRecordSchema.parse({
      sessionId: row["session_id"],
      deviceId: row["device_id"],
      tankId: row["tank_id"],
      operatorId: row["operator_id"],
      machineId: row["machine_id"],
      equipmentNumber: row["equipment_number"] ?? undefined,
      startedAtMs: row["started_at_ms"],
      endedAtMs: row["ended_at_ms"],
      liters: row["liters"],
      endReason: row["end_reason"],
    });
  }

  // --- audit ------------------------------------------------------------------------------

  appendAudit(entry: AuditEntry): void {
    const e = AuditEntrySchema.parse(entry);
    if (e.kind === "correction") {
      const target = e.sessionId === undefined ? undefined : this.findSession(e.sessionId);
      if (target === undefined || e.deltaLiters === undefined) {
        throw new Error("a correction must link an existing session and carry deltaLiters");
      }
    }
    this.#db
      .prepare(
        `INSERT INTO audit_events (entry_id, kind, at_ms, session_id, operator_id, delta_liters, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.entryId,
        e.kind,
        e.atMs,
        e.sessionId ?? null,
        e.operatorId ?? null,
        e.deltaLiters ?? null,
        e.reason ?? null,
      );
  }

  listAudit(): AuditEntry[] {
    const rows = this.#db
      .prepare("SELECT * FROM audit_events ORDER BY at_ms, entry_id")
      .all() as Row[];
    return rows.map((row) =>
      AuditEntrySchema.parse({
        entryId: row["entry_id"],
        kind: row["kind"],
        atMs: row["at_ms"],
        ...(row["session_id"] === null ? {} : { sessionId: row["session_id"] }),
        ...(row["operator_id"] === null ? {} : { operatorId: row["operator_id"] }),
        ...(row["delta_liters"] === null ? {} : { deltaLiters: row["delta_liters"] }),
        ...(row["reason"] === null ? {} : { reason: row["reason"] }),
      }),
    );
  }

  // --- outbox -----------------------------------------------------------------------------

  listOutbox(): OutboxEntry[] {
    const rows = this.#db
      .prepare("SELECT * FROM sync_outbox ORDER BY next_attempt_at_ms")
      .all() as Row[];
    return rows.map((row) => ({
      sessionId: String(row["session_id"]),
      status: String(row["status"]),
      attempts: Number(row["attempts"]),
      nextAttemptAtMs: Number(row["next_attempt_at_ms"]),
    })) as OutboxEntry[];
  }

  /** Apply acknowledgments. Only a pending entry can change, and only to acked or conflict. */
  applyAcks(input: readonly SyncAck[]): void {
    // Parse the whole batch first so one malformed ack cannot partially mark sessions acked.
    const acks = z.array(SyncAckSchema).parse(input);
    this.transaction(() => {
      const update = this.#db.prepare(
        "UPDATE sync_outbox SET status = ? WHERE session_id = ? AND status = 'pending'",
      );
      for (const ack of acks) {
        update.run(ack.status === "conflict" ? "conflict" : "acked", ack.sessionId);
      }
    });
  }

  recordFailure(sessionId: string, attempts: number, nextAttemptAtMs: number): void {
    this.#db
      .prepare(
        "UPDATE sync_outbox SET attempts = ?, next_attempt_at_ms = ? WHERE session_id = ? AND status = 'pending'",
      )
      .run(attempts, nextAttemptAtMs, sessionId);
  }
}
