import { z } from "zod";
import { SessionRecord } from "./ledger.ts";
import { DeviceId, SessionId, type TimestampMs } from "./schemas.ts";
import type { Settings } from "./settings.ts";

export const MAX_BATCH_SIZE = 50;

export const SyncRequest = z.strictObject({
  deviceId: DeviceId,
  sessions: z.array(SessionRecord).min(1).max(MAX_BATCH_SIZE),
});
export type SyncRequest = z.infer<typeof SyncRequest>;

/** stored: first time seen. duplicate: identical record already stored. conflict: same ID, different content. */
export const AckStatus = z.enum(["stored", "duplicate", "conflict"]);
export type AckStatus = z.infer<typeof AckStatus>;

export const SyncAck = z.strictObject({ sessionId: SessionId, status: AckStatus });
export type SyncAck = z.infer<typeof SyncAck>;

export const SyncResponse = z.strictObject({ acks: z.array(SyncAck) });
export type SyncResponse = z.infer<typeof SyncResponse>;

export type OutboxStatus = "pending" | "acked" | "conflict";

export interface OutboxEntry {
  readonly sessionId: SessionId;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly nextAttemptAtMs: TimestampMs;
}

/** True if two records carry exactly the same content. */
export function sameRecord(a: SessionRecord, b: SessionRecord): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.deviceId === b.deviceId &&
    a.tankId === b.tankId &&
    a.operatorId === b.operatorId &&
    a.machineId === b.machineId &&
    a.equipmentNumber === b.equipmentNumber &&
    a.startedAtMs === b.startedAtMs &&
    a.endedAtMs === b.endedAtMs &&
    a.liters === b.liters &&
    a.endReason === b.endReason
  );
}

/**
 * Server-side idempotent apply. At most one record is kept per session ID, the first one seen.
 * The caller must persist `store` durably before sending the acknowledgments (invariant 3).
 */
export function applyBatch(
  store: ReadonlyMap<string, SessionRecord>,
  batch: readonly SessionRecord[],
): { store: ReadonlyMap<string, SessionRecord>; acks: SyncAck[] } {
  const next = new Map(store);
  const acks: SyncAck[] = [];
  for (const record of batch) {
    const existing = next.get(record.sessionId);
    if (existing === undefined) {
      next.set(record.sessionId, Object.freeze({ ...record }));
      acks.push({ sessionId: record.sessionId, status: "stored" });
    } else {
      acks.push({
        sessionId: record.sessionId,
        status: sameRecord(existing, record) ? "duplicate" : "conflict",
      });
    }
  }
  return { store: next, acks };
}

/** Exponential backoff with equal jitter. `random01` is in [0, 1) and is passed in. */
export function retryDelaySeconds(
  attempt: number,
  settings: Pick<Settings, "syncRetryBaseSeconds" | "syncRetryMaxSeconds">,
  random01: number,
): number {
  const n = Math.max(0, Math.floor(attempt));
  const ceiling = Math.min(settings.syncRetryMaxSeconds, settings.syncRetryBaseSeconds * 2 ** n);
  const half = ceiling / 2;
  return half + Math.min(Math.max(random01, 0), 1) * half;
}

export function newOutboxEntry(sessionId: SessionId, nowMs: TimestampMs): OutboxEntry {
  return { sessionId, status: "pending", attempts: 0, nextAttemptAtMs: nowMs };
}

/** Pending entries whose retry time has come, oldest due first, up to `limit`. */
export function dueEntries(
  outbox: readonly OutboxEntry[],
  nowMs: TimestampMs,
  limit = MAX_BATCH_SIZE,
): OutboxEntry[] {
  return outbox
    .filter((e) => e.status === "pending" && e.nextAttemptAtMs <= nowMs)
    .sort((a, b) => a.nextAttemptAtMs - b.nextAttemptAtMs)
    .slice(0, limit);
}

/** A failed attempt keeps the entry pending and schedules the next try. */
export function recordFailure(
  entry: OutboxEntry,
  nowMs: TimestampMs,
  settings: Pick<Settings, "syncRetryBaseSeconds" | "syncRetryMaxSeconds">,
  random01: number,
): OutboxEntry {
  if (entry.status !== "pending") return entry;
  const delayMs = retryDelaySeconds(entry.attempts, settings, random01) * 1000;
  return { ...entry, attempts: entry.attempts + 1, nextAttemptAtMs: Math.round(nowMs + delayMs) };
}

/**
 * Apply server acknowledgments. An entry leaves `pending` only when the server acknowledged it.
 * Acknowledgments for unknown sessions are ignored.
 */
export function applyAcks(outbox: readonly OutboxEntry[], acks: readonly SyncAck[]): OutboxEntry[] {
  const byId = new Map(acks.map((a) => [a.sessionId, a.status] as const));
  return outbox.map((entry) => {
    if (entry.status !== "pending") return entry;
    const status = byId.get(entry.sessionId);
    if (status === undefined) return entry;
    return { ...entry, status: status === "conflict" ? "conflict" : "acked" };
  });
}
