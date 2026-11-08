import { z } from "zod";
import { DeviceId, MachineId, OperatorId, SessionId, TankId, TimestampMs } from "./schemas.ts";

export const EndReasonSchema = z.enum([
  "operator_stop",
  "max_liters",
  "idle_timeout",
  "fault",
  "estop",
  "interrupted",
]);

/** A finalized dispensing session. Immutable once appended. */
export const SessionRecord = z.strictObject({
  sessionId: SessionId,
  deviceId: DeviceId,
  tankId: TankId,
  operatorId: OperatorId,
  machineId: MachineId,
  startedAtMs: TimestampMs,
  endedAtMs: TimestampMs,
  liters: z.number().nonnegative().finite(),
  endReason: EndReasonSchema,
});
export type SessionRecord = z.infer<typeof SessionRecord>;

export const AuditKind = z.enum([
  "authorization_denied",
  "session_finalized",
  "correction",
  "estop",
  "fault",
  "boot",
]);
export type AuditKind = z.infer<typeof AuditKind>;

/** An audit event. Corrections link to the session they amend and never overwrite it. */
export const AuditEntry = z.strictObject({
  entryId: z.uuid(),
  kind: AuditKind,
  atMs: TimestampMs,
  sessionId: SessionId.optional(),
  operatorId: OperatorId.optional(),
  /** Liters added to (positive) or removed from (negative) the linked session. */
  deltaLiters: z.number().finite().optional(),
  /** A snake_case reason code. Free text is rejected so personal data cannot enter the audit trail. */
  reason: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/, "reason must be a snake_case code")
    .optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export interface Ledger {
  readonly sessions: readonly SessionRecord[];
  readonly audit: readonly AuditEntry[];
}

export const emptyLedger: Ledger = Object.freeze({ sessions: [], audit: [] });

export class LedgerError extends Error {
  override name = "LedgerError";
}

/** Append a finalized session. A session ID can be finalized only once. */
export function appendSession(ledger: Ledger, record: SessionRecord): Ledger {
  const parsed = SessionRecord.parse(record);
  if (ledger.sessions.some((s) => s.sessionId === parsed.sessionId)) {
    throw new LedgerError(`session ${parsed.sessionId} is already finalized`);
  }
  return {
    sessions: [...ledger.sessions, Object.freeze(parsed)],
    audit: ledger.audit,
  };
}

/** Append an audit entry. Entry IDs are unique. */
export function appendAudit(ledger: Ledger, entry: AuditEntry): Ledger {
  const parsed = AuditEntry.parse(entry);
  if (ledger.audit.some((a) => a.entryId === parsed.entryId)) {
    throw new LedgerError(`audit entry ${parsed.entryId} already exists`);
  }
  if (parsed.kind === "correction") {
    if (parsed.sessionId === undefined || parsed.deltaLiters === undefined) {
      throw new LedgerError("a correction must link a session and carry deltaLiters");
    }
    const target = parsed.sessionId;
    if (!ledger.sessions.some((s) => s.sessionId === target)) {
      throw new LedgerError(`correction targets unknown session ${target}`);
    }
  }
  return {
    sessions: ledger.sessions,
    audit: [...ledger.audit, Object.freeze(parsed)],
  };
}

/** Liters of a session including linked corrections. The stored record is never changed. */
export function effectiveLiters(ledger: Ledger, sessionId: SessionId): number {
  const session = ledger.sessions.find((s) => s.sessionId === sessionId);
  if (session === undefined) throw new LedgerError(`unknown session ${sessionId}`);
  const delta = ledger.audit
    .filter((a) => a.kind === "correction" && a.sessionId === sessionId)
    .reduce((sum, a) => sum + (a.deltaLiters ?? 0), 0);
  return session.liters + delta;
}
