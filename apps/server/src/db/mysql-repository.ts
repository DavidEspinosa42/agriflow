import { SessionRecord, type SyncAck, sameRecord } from "@agriflow/core";
import { and, eq } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import type { DeviceInfo, SyncRepository } from "./repository.ts";
import { devices, transactions } from "./schema.ts";

const ER_DUP_ENTRY = 1062;

/** True if the error, or anything it wraps, is MySQL's duplicate key error. */
export function isDuplicateKey(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    if (typeof e === "object" && (e as { errno?: unknown }).errno === ER_DUP_ENTRY) return true;
    e = typeof e === "object" ? (e as { cause?: unknown }).cause : undefined;
  }
  return false;
}

export class MysqlSyncRepository implements SyncRepository {
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
          const { receivedAtMs: _ignored, ...stored } = existing;
          acks.push({
            sessionId: record.sessionId,
            status: sameRecord(SessionRecord.parse(stored), record) ? "duplicate" : "conflict",
          });
        }
      }
      return acks;
    });
  }
}
