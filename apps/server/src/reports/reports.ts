import type { SessionRecord } from "@agriflow/core";

export const MS_PER_MINUTE = 60_000;
export const MS_PER_DAY = 86_400_000;

export interface StoredTransaction extends SessionRecord {
  readonly receivedAtMs: number;
}

/** All fields optional; every given field must match. Times are on `startedAtMs`, from inclusive, to exclusive. */
export interface TransactionFilter {
  readonly fromMs?: number | undefined;
  readonly toMs?: number | undefined;
  readonly machineId?: string | undefined;
  readonly operatorId?: string | undefined;
  readonly deviceId?: string | undefined;
}

export interface Page {
  readonly limit: number;
  readonly offset: number;
}

export type GroupBy = "machine" | "operator" | "device" | "day";

export interface ConsumptionRow {
  /** Machine, operator or device id, or a YYYY-MM-DD date for day grouping. */
  readonly key: string;
  readonly liters: number;
  readonly sessions: number;
}

export interface DeviceStatus {
  readonly deviceId: string;
  readonly tankId: string;
  readonly sessions: number;
  /** When the server last stored a session from this device, or null if none yet. */
  readonly lastReceivedAtMs: number | null;
}

/** Read side of the central database, used by the manager dashboard. */
export interface ReportRepository {
  findManagerByTokenHash(tokenHash: string): Promise<{ managerId: string } | undefined>;
  listTransactions(
    filter: TransactionFilter,
    page: Page,
  ): Promise<{ items: StoredTransaction[]; total: number }>;
  consumption(
    filter: TransactionFilter,
    groupBy: GroupBy,
    utcOffsetMinutes: number,
  ): Promise<ConsumptionRow[]>;
  deviceStatus(): Promise<DeviceStatus[]>;
}

/** Liters are summed as floating point; report them to the millilitre. */
export function roundLiters(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Day number since the epoch in the farm's local time, from an absolute timestamp. */
export function localDay(ms: number, utcOffsetMinutes: number): number {
  return Math.floor((ms + utcOffsetMinutes * MS_PER_MINUTE) / MS_PER_DAY);
}

export function dayKey(dayNumber: number): string {
  return new Date(dayNumber * MS_PER_DAY).toISOString().slice(0, 10);
}

export function matches(t: SessionRecord, f: TransactionFilter): boolean {
  return (
    (f.fromMs === undefined || t.startedAtMs >= f.fromMs) &&
    (f.toMs === undefined || t.startedAtMs < f.toMs) &&
    (f.machineId === undefined || t.machineId === f.machineId) &&
    (f.operatorId === undefined || t.operatorId === f.operatorId) &&
    (f.deviceId === undefined || t.deviceId === f.deviceId)
  );
}

/** Newest first, ties broken by session id so paging is stable. */
export function compareNewestFirst(a: SessionRecord, b: SessionRecord): number {
  return b.startedAtMs - a.startedAtMs || (a.sessionId < b.sessionId ? -1 : 1);
}

/** Pure aggregation, used by the in-memory repository and as the reference for SQL. */
export function aggregate(
  rows: readonly SessionRecord[],
  groupBy: GroupBy,
  utcOffsetMinutes: number,
): ConsumptionRow[] {
  const groups = new Map<string, { liters: number; sessions: number }>();
  for (const row of rows) {
    const key =
      groupBy === "machine"
        ? row.machineId
        : groupBy === "operator"
          ? row.operatorId
          : groupBy === "device"
            ? row.deviceId
            : dayKey(localDay(row.startedAtMs, utcOffsetMinutes));
    const group = groups.get(key) ?? { liters: 0, sessions: 0 };
    group.liters += row.liters;
    group.sessions += 1;
    groups.set(key, group);
  }
  return sortConsumption(
    [...groups.entries()].map(([key, g]) => ({
      key,
      liters: roundLiters(g.liters),
      sessions: g.sessions,
    })),
    groupBy,
  );
}

/** Days in date order; everything else by liters, largest first. */
export function sortConsumption(rows: ConsumptionRow[], groupBy: GroupBy): ConsumptionRow[] {
  return rows.sort((a, b) =>
    groupBy === "day"
      ? a.key.localeCompare(b.key)
      : b.liters - a.liters || a.key.localeCompare(b.key),
  );
}
