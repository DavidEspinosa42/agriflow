import {
  dueEntries,
  type OutboxEntry,
  recordFailure,
  type SessionRecord,
  SyncResponse,
} from "@agriflow/core";
import type { ControllerStore } from "../storage/store.ts";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SyncWorkerOptions {
  readonly store: ControllerStore;
  readonly deviceId: string;
  /** Base URL of the central server, for example https://agriflow.example.com */
  readonly serverUrl: string;
  /** Device bearer token. Never logged. */
  readonly token: string;
  readonly now: () => number;
  readonly random?: () => number;
  readonly fetch?: Fetch;
  /** Abort a request that takes longer than this. */
  readonly timeoutMs?: number;
}

export type SyncOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "synced"; readonly sent: number; readonly acked: number }
  | { readonly kind: "failed"; readonly sent: number; readonly reason: string };

/**
 * Sends pending sessions to the server. An entry leaves `pending` only when the server
 * acknowledges it (invariant 3); any failure keeps it pending and schedules a jittered retry.
 */
export class SyncWorker {
  readonly #o: SyncWorkerOptions;
  readonly #fetch: Fetch;
  #running = false;

  constructor(options: SyncWorkerOptions) {
    this.#o = options;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** One sync attempt. Concurrent calls are ignored while one is in flight. */
  async runOnce(): Promise<SyncOutcome> {
    if (this.#running) return { kind: "idle" };
    this.#running = true;
    try {
      return await this.#attempt();
    } finally {
      this.#running = false;
    }
  }

  async #attempt(): Promise<SyncOutcome> {
    const { store, now } = this.#o;
    const due = dueEntries(store.listOutbox(), now());
    if (due.length === 0) return { kind: "idle" };
    const records: SessionRecord[] = [];
    for (const entry of due) {
      const record = store.findSession(entry.sessionId);
      if (record !== undefined) records.push(record);
    }
    if (records.length === 0) return { kind: "idle" };
    const sent = new Set(records.map((r) => r.sessionId));
    const batch = due.filter((e) => sent.has(e.sessionId));

    let reason: string;
    try {
      const response = await this.#fetch(
        `${this.#o.serverUrl.replace(/\/+$/, "")}/v1/sync/sessions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.#o.token}`,
          },
          body: JSON.stringify({ deviceId: this.#o.deviceId, sessions: records }),
          signal: AbortSignal.timeout(this.#o.timeoutMs ?? 10_000),
        },
      );
      if (!response.ok) {
        reason = `http_${response.status}`;
      } else {
        const parsed = SyncResponse.safeParse(await response.json());
        if (!parsed.success) {
          reason = "invalid_response";
        } else {
          // Only acks for sessions we actually sent can change state.
          const acks = parsed.data.acks.filter((a) => sent.has(a.sessionId));
          store.applyAcks(acks);
          const acked = new Set(acks.map((a) => a.sessionId));
          this.#scheduleRetries(batch.filter((e) => !acked.has(e.sessionId)));
          return { kind: "synced", sent: records.length, acked: acks.length };
        }
      }
    } catch (error) {
      reason = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
    }
    this.#scheduleRetries(batch);
    return { kind: "failed", sent: records.length, reason };
  }

  #scheduleRetries(entries: readonly OutboxEntry[]): void {
    const { store, now } = this.#o;
    const settings = store.getSettings();
    const random = this.#o.random ?? Math.random;
    for (const entry of entries) {
      const next = recordFailure(entry, now(), settings, random());
      store.recordFailure(entry.sessionId, next.attempts, next.nextAttemptAtMs);
    }
  }
}
