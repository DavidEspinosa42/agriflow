import {
  type AuditEntry,
  type AuthorizationDecision,
  authorize,
  type DenyReason,
  DeviceId,
  deltaPulses,
  EquipmentNumber,
  flowRateLitersPerMinute,
  initialState,
  isAuthorizationValid,
  isPlausibleFlow,
  type Notice,
  pulsesToLiters,
  pumpEnabled,
  recover,
  reduce,
  type SessionEvent,
  SessionId,
  SessionRecord,
  type SessionState,
  type Settings,
  type Snapshot,
  TankId,
} from "@agriflow/core";
import type { Hardware } from "../hardware/interfaces.ts";
import type { ControllerStore } from "../storage/store.ts";

export interface DispensingServiceOptions {
  readonly store: ControllerStore;
  readonly hardware: Hardware;
  readonly deviceId: string;
  readonly tankId: string;
  /** Milliseconds since the epoch. Injected so tests control time. */
  readonly now: () => number;
  /** Maps a raw fob UID to the stored credential reference. */
  readonly hashUid: (uid: string) => string;
  readonly newId?: () => string;
}

export type { Notice, Snapshot } from "@agriflow/core";

const PLAUSIBILITY_WINDOW_MS = 1000;

interface PendingScan {
  readonly credentialRef: string | undefined;
  readonly atMs: number;
}

/**
 * Orchestrates one pump. Safety rules enforced here:
 * - the relay is commanded off before anything is persisted when dispensing ends;
 * - progress is checkpointed before the relay is enabled;
 * - every boot starts with the relay off and closes any unfinished session as interrupted.
 */
export class DispensingService {
  readonly #o: DispensingServiceOptions;
  readonly #newId: () => string;
  #settings: Settings;
  #state: SessionState = initialState;
  #pending: PendingScan | null = null;
  #notice: Notice = { kind: "none" };
  #lastPulses = 0;
  #lastCheckpointMs = 0;
  /** Plausibility window: pulse slack applies once per window, so it cannot hide sustained excess. */
  #windowStartMs = 0;
  #windowLiters = 0;
  /** A finished session whose durable write failed. Retried until it succeeds. */
  #unpersisted: Extract<SessionState, { kind: "finished" }> | null = null;

  constructor(options: DispensingServiceOptions) {
    // Fail at construction, before fuel can flow, rather than when the first session is recorded.
    DeviceId.parse(options.deviceId);
    TankId.parse(options.tankId);
    this.#o = options;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#settings = options.store.getSettings();
  }

  /** Run once at startup, before any input is accepted. */
  boot(): void {
    const { hardware, store } = this.#o;
    hardware.relay.disable();
    this.#settings = store.getSettings();
    const nowMs = this.#o.now();
    const unfinished = store.findOpenSession();
    if (unfinished !== null) {
      const closed = recover(unfinished);
      if (closed.kind === "finished") this.#persistFinished(closed, nowMs);
    }
    this.#audit({ kind: "boot", atMs: nowMs });
    this.#state = initialState;
    this.#lastPulses = hardware.meter.readPulses();
    this.#lastCheckpointMs = nowMs;
    if (hardware.estop.isEngaged()) this.#notice = { kind: "fault", reason: "estop_engaged" };
  }

  snapshot(): Snapshot {
    const s = this.#state;
    const base = {
      pumpOn: this.#o.hardware.relay.isEnabled(),
      estopEngaged: this.#o.hardware.estop.isEngaged(),
      notice: this.#notice,
    };
    switch (s.kind) {
      case "idle":
        return {
          ...base,
          phase: this.#pending === null ? "idle" : "awaiting_machine",
          operatorId: null,
          machineId: null,
          liters: 0,
          endReason: null,
        };
      case "authorized":
        return {
          ...base,
          phase: "authorized",
          operatorId: s.authorization.operatorId,
          machineId: s.authorization.machineId,
          liters: 0,
          endReason: null,
        };
      case "dispensing":
        return {
          ...base,
          phase: "dispensing",
          operatorId: s.operatorId,
          machineId: s.machineId,
          liters: s.liters,
          endReason: null,
        };
      case "finished":
        return {
          ...base,
          phase: "finished",
          operatorId: s.operatorId,
          machineId: s.machineId,
          liters: s.liters,
          endReason: s.endReason,
        };
    }
  }

  /** A fob was presented. Unknown fobs are audited without storing the UID. */
  handleScan(uid: string): void {
    if (this.#state.kind !== "idle") return;
    const nowMs = this.#o.now();
    this.#notice = { kind: "none" };
    const credentialRef = this.#o.hashUid(uid);
    const credential = this.#o.store.findCredential(credentialRef);
    if (credential === undefined) {
      this.#deny("unknown_credential", nowMs);
      this.#pending = null;
      return;
    }
    this.#pending = { credentialRef, atMs: nowMs };
  }

  /** The operator entered an equipment number after presenting a fob. */
  selectMachine(equipmentNumber: string): AuthorizationDecision | undefined {
    const nowMs = this.#o.now();
    if (this.#state.kind !== "idle" || this.#pending === null) return undefined;
    const pending = this.#pending;
    if (nowMs - pending.atMs >= this.#settings.authorizationTtlSeconds * 1000) {
      this.#pending = null;
      this.#notice = { kind: "lapsed" };
      return undefined;
    }
    const parsed = EquipmentNumber.safeParse(equipmentNumber);
    const credential =
      pending.credentialRef === undefined
        ? undefined
        : this.#o.store.findCredential(pending.credentialRef);
    const machine = parsed.success
      ? this.#o.store.findMachineByEquipmentNumber(parsed.data)
      : undefined;
    const decision = authorize({ nowMs, credential, machine, settings: this.#settings });
    this.#pending = null;
    if (!decision.allowed) {
      this.#deny(decision.reason, nowMs, credential?.operatorId);
      return decision;
    }
    this.#notice = { kind: "none" };
    // The window runs from fob presentation, not from machine selection.
    const deadlineMs = pending.atMs + this.#settings.authorizationTtlSeconds * 1000;
    this.#apply({
      type: "authorized",
      authorization: {
        ...decision.authorization,
        expiresAtMs: Math.min(decision.authorization.expiresAtMs, deadlineMs),
      },
    });
    return decision;
  }

  /** The operator pressed start. The pump runs only if the authorization is still valid. */
  start(): void {
    const { hardware, store } = this.#o;
    const nowMs = this.#o.now();
    if (this.#state.kind !== "authorized") return;
    const authorization = this.#state.authorization;
    if (hardware.estop.isEngaged()) {
      this.#apply({ type: "stop", nowMs });
      this.#notice = { kind: "fault", reason: "estop_engaged" };
      return;
    }
    const next = reduce(
      this.#state,
      { type: "start", nowMs, sessionId: SessionId.parse(this.#newId()) },
      this.#settings,
    );
    if (next.kind !== "dispensing") {
      this.#state = next;
      this.#notice = { kind: "lapsed" };
      return;
    }
    // Durably record the session before fuel can flow. If this fails, the pump stays off.
    try {
      store.checkpoint({
        sessionId: next.sessionId,
        operatorId: next.operatorId,
        machineId: next.machineId,
        startedAtMs: next.startedAtMs,
        lastCheckpointAtMs: nowMs,
        liters: 0,
      });
    } catch (error) {
      hardware.relay.disable();
      this.#state = initialState;
      this.#notice = { kind: "fault", reason: "storage_failure" };
      throw error;
    }
    // The checkpoint write and the meter read take time. Read the baseline first, then re-read
    // the clock and revalidate as the very last step before the relay.
    let baseline: number;
    try {
      baseline = hardware.meter.readPulses();
    } catch (error) {
      store.discardUnstartedSession(next.sessionId);
      this.#state = initialState;
      this.#notice = { kind: "fault", reason: "meter_unreadable" };
      throw error;
    }
    if (!deltaPulses(baseline, baseline).ok) {
      store.discardUnstartedSession(next.sessionId);
      this.#state = initialState;
      this.#notice = { kind: "fault", reason: "meter_unreadable" };
      return;
    }
    const beforeRelayMs = this.#o.now();
    if (!isAuthorizationValid(authorization, beforeRelayMs) || hardware.estop.isEngaged()) {
      store.discardUnstartedSession(next.sessionId);
      this.#state = initialState;
      this.#notice = { kind: "lapsed" };
      return;
    }
    this.#state = next;
    this.#lastPulses = baseline;
    this.#lastCheckpointMs = beforeRelayMs;
    this.#windowStartMs = beforeRelayMs;
    this.#windowLiters = 0;
    hardware.relay.enable();
  }

  stop(): void {
    this.#pending = null;
    const nowMs = this.#o.now();
    this.#o.hardware.relay.disable();
    if (this.#drainMeter(nowMs) === "rejected") {
      this.#fault(nowMs, "implausible_flow", false);
      return;
    }
    this.#apply({ type: "stop", nowMs });
  }

  /** Called when the E-stop input changes. Engaging it ends any running session. */
  handleEstop(engaged: boolean): void {
    if (!engaged) return;
    const nowMs = this.#o.now();
    this.#o.hardware.relay.disable();
    this.#drainMeter(nowMs);
    this.#apply({ type: "estop", nowMs });
    this.#notice = { kind: "fault", reason: "estop_engaged" };
  }

  /** Acknowledge the finished screen and return to idle. */
  dismiss(): void {
    // A session that is not yet durably recorded must not be discarded.
    if (this.#unpersisted !== null) return;
    this.#apply({ type: "reset" });
    this.#notice = { kind: "none" };
  }

  /** Called periodically by the runner. Reads the meter, enforces limits and checkpoints. */
  tick(): void {
    try {
      this.#tick();
    } catch (error) {
      // Any unexpected failure while dispensing must leave the pump off.
      this.failSafe();
      throw error;
    }
  }

  /**
   * Called when something outside the service fails and the pump state cannot be trusted. The
   * relay goes off, any pending scan or authorization is dropped, and a running session is
   * ended as a fault, so a later start needs a fresh authorization.
   */
  failSafe(): void {
    this.#o.hardware.relay.disable();
    this.#pending = null;
    if (this.#state.kind === "dispensing" || this.#state.kind === "authorized") {
      const nowMs = this.#o.now();
      if (this.#state.kind === "dispensing") {
        try {
          // The relay is already off. Count pulses that are still outstanding and valid.
          this.#drainMeter(nowMs);
        } catch {
          // An unreadable meter must not block ending the session; progress so far is kept.
        }
      }
      this.#apply({ type: "fault", nowMs });
      this.#notice = { kind: "fault", reason: "internal_error" };
    }
  }

  #tick(): void {
    const { hardware, store } = this.#o;
    const nowMs = this.#o.now();
    this.#retryPersist();
    if (this.#pending !== null) {
      if (nowMs - this.#pending.atMs >= this.#settings.authorizationTtlSeconds * 1000) {
        this.#pending = null;
        this.#notice = { kind: "lapsed" };
      }
    }
    if (hardware.estop.isEngaged() && pumpEnabled(this.#state)) {
      this.handleEstop(true);
      return;
    }
    if (this.#state.kind === "dispensing") {
      const reading = hardware.meter.readPulses();
      const delta = deltaPulses(this.#lastPulses, reading);
      if (!delta.ok) {
        this.#fault(nowMs, delta.reason, false);
        return;
      }
      const liters = pulsesToLiters(delta.pulses, this.#settings);
      if (!this.#accept(liters, nowMs)) {
        this.#fault(nowMs, "implausible_flow", false);
        return;
      }
      this.#lastPulses = reading;
      this.#apply({ type: "flow", nowMs, liters });
    }
    this.#apply({ type: "tick", nowMs });
    const s = this.#state;
    if (
      s.kind === "dispensing" &&
      nowMs - this.#lastCheckpointMs >= this.#settings.checkpointIntervalSeconds * 1000
    ) {
      try {
        store.checkpoint({
          sessionId: s.sessionId,
          operatorId: s.operatorId,
          machineId: s.machineId,
          startedAtMs: s.startedAtMs,
          lastCheckpointAtMs: nowMs,
          liters: s.liters,
        });
        this.#lastCheckpointMs = nowMs;
      } catch {
        this.#fault(nowMs, "storage_failure");
      }
    }
  }

  // --- internals --------------------------------------------------------------------------

  /**
   * Flow within the physical limit. One pulse of slack is allowed because pulses are discrete,
   * so a legitimate pulse landing in a very short interval is not mistaken for a burst.
   */
  #accept(liters: number, nowMs: number): boolean {
    const total = this.#windowLiters + liters;
    const adjusted = Math.max(0, total - this.#settings.litersPerPulse);
    const rate = flowRateLitersPerMinute(adjusted, this.#windowStartMs, nowMs);
    if (!isPlausibleFlow(rate, this.#settings)) return false;
    this.#windowLiters = total;
    if (nowMs - this.#windowStartMs >= PLAUSIBILITY_WINDOW_MS) {
      this.#windowStartMs = nowMs;
      this.#windowLiters = 0;
    }
    return true;
  }

  /** Count pulses delivered since the last read so the final total includes them. */
  #drainMeter(nowMs: number): "ok" | "rejected" {
    if (this.#state.kind !== "dispensing") return "ok";
    let reading: number;
    try {
      reading = this.#o.hardware.meter.readPulses();
    } catch {
      return "rejected";
    }
    const delta = deltaPulses(this.#lastPulses, reading);
    if (!delta.ok) return "rejected";
    const liters = pulsesToLiters(delta.pulses, this.#settings);
    if (!this.#accept(liters, nowMs)) return "rejected";
    this.#lastPulses = reading;
    this.#apply({ type: "flow", nowMs, liters });
    return "ok";
  }

  /** End the session on a fault. Rejected meter readings are never counted as delivered fuel. */
  #fault(nowMs: number, reason: string, drain = true): void {
    this.#o.hardware.relay.disable();
    if (drain) this.#drainMeter(nowMs);
    this.#apply({ type: "fault", nowMs });
    this.#notice = { kind: "fault", reason };
  }

  /** Apply an event. Leaving the dispensing state turns the relay off before persisting. */
  #apply(event: SessionEvent): void {
    const before = this.#state;
    const after = reduce(before, event, this.#settings);
    if (!pumpEnabled(after)) this.#o.hardware.relay.disable();
    this.#state = after;
    if (before.kind === "authorized" && after.kind === "idle" && event.type === "tick") {
      this.#notice = { kind: "lapsed" };
    }
    if (after.kind === "finished" && before.kind !== "finished") {
      this.#unpersisted = after;
      this.#retryPersist();
    }
  }

  /** Retry storing a finished session that could not be written. True when nothing is waiting. */
  flush(): boolean {
    this.#retryPersist();
    return this.#unpersisted === null;
  }

  #retryPersist(): void {
    if (this.#unpersisted === null) return;
    try {
      this.#persistFinished(this.#unpersisted, this.#o.now());
      this.#unpersisted = null;
      if (this.#notice.kind === "fault" && this.#notice.reason === "storage_failure") {
        this.#notice = { kind: "none" };
      }
    } catch {
      this.#notice = { kind: "fault", reason: "storage_failure" };
    }
  }

  #persistFinished(state: Extract<SessionState, { kind: "finished" }>, nowMs: number): void {
    const { store, deviceId, tankId } = this.#o;
    const record = SessionRecord.parse({
      sessionId: state.sessionId,
      deviceId,
      tankId,
      operatorId: state.operatorId,
      machineId: state.machineId,
      startedAtMs: state.startedAtMs,
      endedAtMs: state.endedAtMs,
      liters: state.liters,
      endReason: state.endReason,
    });
    store.transaction(() => {
      store.finalizeSession(record, nowMs);
      this.#audit({
        kind: "session_finalized",
        atMs: nowMs,
        sessionId: record.sessionId,
        operatorId: record.operatorId,
        reason: record.endReason,
      });
    });
  }

  #deny(reason: DenyReason, atMs: number, operatorId?: string): void {
    this.#notice = { kind: "denied", reason };
    this.#audit({
      kind: "authorization_denied",
      atMs,
      reason,
      ...(operatorId === undefined ? {} : { operatorId: operatorId as AuditEntry["operatorId"] }),
    });
  }

  #audit(entry: Omit<AuditEntry, "entryId">): void {
    this.#o.store.appendAudit({ ...entry, entryId: this.#newId() } as AuditEntry);
  }
}
