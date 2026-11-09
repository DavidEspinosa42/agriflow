import { SessionRecord, type SyncAck, sameRecord } from "@agriflow/core";
import { and, asc, count, desc, eq, gte, lt, max, type SQL, sql, sum } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import {
  type ConsumptionRow,
  type DeviceStatus,
  dayKey,
  type GroupBy,
  MS_PER_DAY,
  MS_PER_MINUTE,
  type Page,
  type ReportRepository,
  roundLiters,
  type StoredTransaction,
  sortConsumption,
  type TransactionFilter,
} from "../reports/reports.ts";
import type { DeviceInfo, SyncRepository } from "./repository.ts";
import { devices, managers, transactions } from "./schema.ts";

const ER_DUP_ENTRY = 1062;

/** True if the error, or anything it wraps, is MySQL's duplicate key error. */
export function isDuplicateKey(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    if (typeof e === "object" && (e as { errno?: unknown }).errno === ER_DUP_ENTRY) return true;
    e = typeof e === "object" ? (e as { cause?: unknown }).cause : undefined;
  }
  return false;
}

export class MysqlRepository implements SyncRepository, ReportRepository {
  readonly #db: MySql2Database;

  constructor(db: MySql2Database) {
    this.#db = db;
  }

  async findDeviceByTokenHash(tokenHash: string): Promise<DeviceInfo | undefined> {
    const rows = await this.#db
      .select({ deviceId: devices.deviceId, tankId: devices.tankId })
      .from(devices)
      .where(and(eq(devices.tokenHash, tokenHash), eq(devices.revoked, false)))
      .limit(1);
    return rows[0];
  }

  /**
   * One transaction for the whole batch. A duplicate-key failure on a single insert only rolls
   * back that statement in MySQL, so the rest of the batch proceeds. Nothing is acknowledged
   * unless the transaction commits.
   */
  async storeBatch(records: readonly SessionRecord[], nowMs: number): Promise<SyncAck[]> {
    return this.#db.transaction(async (tx) => {
      const acks: SyncAck[] = [];
      for (const record of records) {
        try {
          await tx.insert(transactions).values({ ...record, receivedAtMs: nowMs });
          acks.push({ sessionId: record.sessionId, status: "stored" });
        } catch (error) {
          if (!isDuplicateKey(error)) throw error;
          const [existing] = await tx
            .select()
            .from(transactions)
            .where(eq(transactions.sessionId, record.sessionId))
            .limit(1)
            // A current read: a plain SELECT would use the transaction snapshot and could miss
            // a row another transaction committed after this one started.
            .for("share");
          if (existing === undefined) throw error;
          const stored = withoutReceived(existing);
          acks.push({
            sessionId: record.sessionId,
            status: sameRecord(SessionRecord.parse(stored), record) ? "duplicate" : "conflict",
          });
        }
      }
      return acks;
    });
  }

  async findManagerByTokenHash(tokenHash: string): Promise<{ managerId: string } | undefined> {
    const rows = await this.#db
      .select({ managerId: managers.managerId })
      .from(managers)
      .where(and(eq(managers.tokenHash, tokenHash), eq(managers.revoked, false)))
      .limit(1);
    return rows[0];
  }

  async listTransactions(
    filter: TransactionFilter,
    page: Page,
  ): Promise<{ items: StoredTransaction[]; total: number }> {
    const where = and(...conditions(filter));
    const [items, totals] = await Promise.all([
      this.#db
        .select()
        .from(transactions)
        .where(where)
        .orderBy(desc(transactions.startedAtMs), asc(transactions.sessionId))
        .limit(page.limit)
        .offset(page.offset),
      this.#db.select({ total: count() }).from(transactions).where(where),
    ]);
    return {
      items: items.map((row) => ({
        ...SessionRecord.parse(withoutReceived(row)),
        receivedAtMs: row.receivedAtMs,
      })),
      total: totals[0]?.total ?? 0,
    };
  }

  async consumption(
    filter: TransactionFilter,
    groupBy: GroupBy,
    utcOffsetMinutes: number,
  ): Promise<ConsumptionRow[]> {
    const key: SQL =
      groupBy === "machine"
        ? sql`${transactions.machineId}`
        : groupBy === "operator"
          ? sql`${transactions.operatorId}`
          : groupBy === "device"
            ? sql`${transactions.deviceId}`
            : sql`CAST(FLOOR((${transactions.startedAtMs} + ${utcOffsetMinutes * MS_PER_MINUTE}) / ${MS_PER_DAY}) AS SIGNED)`;
    const rows = await this.#db
      .select({
        key: sql<string>`${key}`.as("group_key"),
        // Machines are shown by equipment number; the id stays the key.
        label:
          groupBy === "machine"
            ? sql<string | null>`MAX(${transactions.equipmentNumber})`
            : sql<null>`NULL`,
        liters: sum(transactions.liters),
        sessions: count(),
      })
      .from(transactions)
      .where(and(...conditions(filter)))
      .groupBy(sql`group_key`);
    return sortConsumption(
      rows.map((row) => ({
        key: groupBy === "day" ? dayKey(Number(row.key)) : String(row.key),
        ...(row.label === null || row.label === undefined ? {} : { label: String(row.label) }),
        liters: roundLiters(Number(row.liters ?? 0)),
        sessions: Number(row.sessions),
      })),
      groupBy,
    );
  }

  async deviceStatus(): Promise<DeviceStatus[]> {
    const rows = await this.#db
      .select({
        deviceId: devices.deviceId,
        tankId: devices.tankId,
        sessions: count(transactions.sessionId),
        lastReceivedAtMs: max(transactions.receivedAtMs),
      })
      .from(devices)
      .leftJoin(transactions, eq(transactions.deviceId, devices.deviceId))
      .where(eq(devices.revoked, false))
      .groupBy(devices.deviceId, devices.tankId)
      .orderBy(asc(devices.deviceId));
    return rows.map((row) => ({
      deviceId: row.deviceId,
      tankId: row.tankId,
      sessions: Number(row.sessions),
      lastReceivedAtMs: row.lastReceivedAtMs === null ? null : Number(row.lastReceivedAtMs),
    }));
  }
}

function conditions(filter: TransactionFilter): SQL[] {
  const out: SQL[] = [];
  if (filter.fromMs !== undefined) out.push(gte(transactions.startedAtMs, filter.fromMs));
  if (filter.toMs !== undefined) out.push(lt(transactions.startedAtMs, filter.toMs));
  if (filter.machineId !== undefined) out.push(eq(transactions.machineId, filter.machineId));
  if (filter.operatorId !== undefined) out.push(eq(transactions.operatorId, filter.operatorId));
  if (filter.deviceId !== undefined) out.push(eq(transactions.deviceId, filter.deviceId));
  return out;
}

/** A stored row as the wire record: no receive time, and no `null` for an absent equipment number. */
function withoutReceived<T extends { receivedAtMs: number; equipmentNumber: string | null }>(
  row: T,
): Omit<T, "receivedAtMs" | "equipmentNumber"> & { equipmentNumber?: string } {
  const { receivedAtMs: _ignored, equipmentNumber, ...rest } = row;
  return equipmentNumber === null ? rest : { ...rest, equipmentNumber };
}
