import { createHash } from "node:crypto";
import { applyBatch, type SessionRecord, type SyncAck } from "@agriflow/core";
import {
  aggregate,
  type ConsumptionRow,
  compareNewestFirst,
  type DeviceStatus,
  type GroupBy,
  matches,
  type Page,
  type ReportRepository,
  type StoredTransaction,
  type TransactionFilter,
} from "../reports/reports.ts";

export interface DeviceInfo {
  readonly deviceId: string;
  readonly tankId: string;
}

/** Storage port for the sync endpoint. Implemented by MySQL and, for tests, in memory. */
export interface SyncRepository {
  /** The active device that owns this token hash, if any. */
  findDeviceByTokenHash(tokenHash: string): Promise<DeviceInfo | undefined>;
  /**
   * Durably store the batch and return one acknowledgment per record. Acknowledgments are only
   * returned after the data is committed (invariant 3). Replays return "duplicate", a different
   * record under an existing ID returns "conflict" and is never stored.
   */
  storeBatch(records: readonly SessionRecord[], nowMs: number): Promise<SyncAck[]>;
}

/** Tokens are random and high entropy, so a plain SHA-256 is enough to store them safely. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** In-memory repository used by tests and local development without MySQL. */
export class MemoryRepository implements SyncRepository, ReportRepository {
  readonly #devices = new Map<string, DeviceInfo & { revoked: boolean }>();
  readonly #deviceByToken = new Map<string, string>();
  readonly #managers = new Map<string, string>();
  readonly #received = new Map<string, number>();
  #records: ReadonlyMap<string, SessionRecord> = new Map();

  addDevice(device: DeviceInfo, token: string): void {
    this.#devices.set(device.deviceId, { ...device, revoked: false });
    this.#deviceByToken.set(hashToken(token), device.deviceId);
  }

  revokeDevice(deviceId: string): void {
    const device = this.#devices.get(deviceId);
    if (device !== undefined) device.revoked = true;
  }

  addManager(managerId: string, token: string): void {
    this.#managers.set(hashToken(token), managerId);
  }

  async findDeviceByTokenHash(tokenHash: string): Promise<DeviceInfo | undefined> {
    const device = this.#devices.get(this.#deviceByToken.get(tokenHash) ?? "");
    return device === undefined || device.revoked
      ? undefined
      : { deviceId: device.deviceId, tankId: device.tankId };
  }

  async storeBatch(records: readonly SessionRecord[], nowMs: number): Promise<SyncAck[]> {
    const result = applyBatch(this.#records, records);
    for (const ack of result.acks) {
      if (ack.status === "stored") this.#received.set(ack.sessionId, nowMs);
    }
    this.#records = result.store;
    return result.acks;
  }

  all(): SessionRecord[] {
    return [...this.#records.values()];
  }

  async findManagerByTokenHash(tokenHash: string): Promise<{ managerId: string } | undefined> {
    const managerId = this.#managers.get(tokenHash);
    return managerId === undefined ? undefined : { managerId };
  }

  async listTransactions(
    filter: TransactionFilter,
    page: Page,
  ): Promise<{ items: StoredTransaction[]; total: number }> {
    const rows = this.all()
      .filter((r) => matches(r, filter))
      .sort(compareNewestFirst);
    return {
      total: rows.length,
      items: rows
        .slice(page.offset, page.offset + page.limit)
        .map((r) => ({ ...r, receivedAtMs: this.#received.get(r.sessionId) ?? 0 })),
    };
  }

  async consumption(
    filter: TransactionFilter,
    groupBy: GroupBy,
    utcOffsetMinutes: number,
  ): Promise<ConsumptionRow[]> {
    return aggregate(
      this.all().filter((r) => matches(r, filter)),
      groupBy,
      utcOffsetMinutes,
    );
  }

  async deviceStatus(): Promise<DeviceStatus[]> {
    return [...this.#devices.values()]
      .filter((d) => !d.revoked)
      .map((d) => {
        const mine = this.all().filter((r) => r.deviceId === d.deviceId);
        const times = mine.map((r) => this.#received.get(r.sessionId) ?? 0);
        return {
          deviceId: d.deviceId,
          tankId: d.tankId,
          sessions: mine.length,
          lastReceivedAtMs: times.length === 0 ? null : Math.max(...times),
        };
      })
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }
}
