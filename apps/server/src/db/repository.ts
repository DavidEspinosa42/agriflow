import { createHash } from "node:crypto";
import { applyBatch, type SessionRecord, type SyncAck } from "@agriflow/core";

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
export class MemorySyncRepository implements SyncRepository {
  readonly #devices = new Map<string, DeviceInfo>();
  #records: ReadonlyMap<string, SessionRecord> = new Map();

  addDevice(device: DeviceInfo, token: string): void {
    this.#devices.set(hashToken(token), device);
  }

  async findDeviceByTokenHash(tokenHash: string): Promise<DeviceInfo | undefined> {
    return this.#devices.get(tokenHash);
  }

  async storeBatch(records: readonly SessionRecord[]): Promise<SyncAck[]> {
    const result = applyBatch(this.#records, records);
    this.#records = result.store;
    return result.acks;
  }

  all(): SessionRecord[] {
    return [...this.#records.values()];
  }
}
