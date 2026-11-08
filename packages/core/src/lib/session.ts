import { type Authorization, isAuthorizationValid } from "./authorization.ts";
import type { MachineId, OperatorId, SessionId, TimestampMs } from "./schemas.ts";
import type { Settings } from "./settings.ts";

export type EndReason =
  | "operator_stop"
  | "max_liters"
  | "idle_timeout"
  | "fault"
  | "estop"
  | "interrupted";

export type SessionState =
  | { readonly kind: "idle" }
  | { readonly kind: "authorized"; readonly authorization: Authorization }
  | {
      readonly kind: "dispensing";
      readonly sessionId: SessionId;
      readonly operatorId: OperatorId;
      readonly machineId: MachineId;
      readonly startedAtMs: TimestampMs;
      readonly lastFlowAtMs: TimestampMs;
      readonly liters: number;
    }
  | {
      readonly kind: "finished";
      readonly sessionId: SessionId;
      readonly operatorId: OperatorId;
      readonly machineId: MachineId;
      readonly startedAtMs: TimestampMs;
      readonly endedAtMs: TimestampMs;
      readonly liters: number;
      readonly endReason: EndReason;
    };

export type SessionEvent =
  | { readonly type: "authorized"; readonly authorization: Authorization }
  | { readonly type: "start"; readonly nowMs: TimestampMs; readonly sessionId: SessionId }
  | { readonly type: "flow"; readonly nowMs: TimestampMs; readonly liters: number }
  | { readonly type: "tick"; readonly nowMs: TimestampMs }
  | { readonly type: "stop"; readonly nowMs: TimestampMs }
  | { readonly type: "fault"; readonly nowMs: TimestampMs }
  | { readonly type: "estop"; readonly nowMs: TimestampMs }
  | { readonly type: "reset" };

/** Every boot starts here. The pump is off. */
export const initialState: SessionState = { kind: "idle" };

/** The pump may run only while dispensing. This is the single source of truth for the relay. */
export function pumpEnabled(state: SessionState): boolean {
  return state.kind === "dispensing";
}

type SessionSettings = Pick<Settings, "maxSessionLiters" | "idleTimeoutSeconds">;

type Dispensing = Extract<SessionState, { kind: "dispensing" }>;

function finish(state: Dispensing, nowMs: TimestampMs, endReason: EndReason): SessionState {
  return {
    kind: "finished",
    sessionId: state.sessionId,
    operatorId: state.operatorId,
    machineId: state.machineId,
    startedAtMs: state.startedAtMs,
    endedAtMs: Math.max(nowMs, state.startedAtMs, state.lastFlowAtMs),
    liters: state.liters,
    endReason,
  };
}

/** Pure transition function. Unknown or out-of-order events leave the state unchanged. */
export function reduce(
  state: SessionState,
  event: SessionEvent,
  settings: SessionSettings,
): SessionState {
  switch (event.type) {
    case "authorized":
      return state.kind === "idle"
        ? { kind: "authorized", authorization: event.authorization }
        : state;

    case "start": {
      if (state.kind !== "authorized") return state;
      if (!isAuthorizationValid(state.authorization, event.nowMs)) return initialState;
      return {
        kind: "dispensing",
        sessionId: event.sessionId,
        operatorId: state.authorization.operatorId,
        machineId: state.authorization.machineId,
        startedAtMs: event.nowMs,
        lastFlowAtMs: event.nowMs,
        liters: 0,
      };
    }

    case "flow": {
      if (state.kind !== "dispensing") return state;
      // A negative or non-finite reading is a metering anomaly: fail safe with the pump off.
      if (!Number.isFinite(event.liters) || event.liters < 0) {
        return finish(state, event.nowMs, "fault");
      }
      // Readings that predate this session belong to an earlier one; never count them.
      if (event.nowMs < state.startedAtMs || event.liters === 0) return state;
      const next: Dispensing = {
        ...state,
        liters: state.liters + event.liters,
        lastFlowAtMs: Math.max(state.lastFlowAtMs, event.nowMs),
      };
      return next.liters >= settings.maxSessionLiters
        ? finish(next, event.nowMs, "max_liters")
        : next;
    }

    case "tick": {
      if (state.kind === "authorized") {
        return isAuthorizationValid(state.authorization, event.nowMs) ? state : initialState;
      }
      if (state.kind === "dispensing") {
        const idleMs = event.nowMs - state.lastFlowAtMs;
        return idleMs >= settings.idleTimeoutSeconds * 1000
          ? finish(state, event.nowMs, "idle_timeout")
          : state;
      }
      return state;
    }

    case "stop":
      if (state.kind === "dispensing") return finish(state, event.nowMs, "operator_stop");
      if (state.kind === "authorized") return initialState;
      return state;

    case "fault":
    case "estop":
      if (state.kind === "dispensing") return finish(state, event.nowMs, event.type);
      if (state.kind === "authorized") return initialState;
      return state;

    case "reset":
      return state.kind === "finished" ? initialState : state;
  }
}

export interface PersistedOpenSession {
  readonly sessionId: SessionId;
  readonly operatorId: OperatorId;
  readonly machineId: MachineId;
  readonly startedAtMs: TimestampMs;
  readonly lastCheckpointAtMs: TimestampMs;
  readonly liters: number;
}

/**
 * Recover after a restart. A session that was dispensing is never resumed: it is closed as
 * interrupted with the last durable liters. Everything else becomes idle with the pump off.
 */
export function recover(persisted: PersistedOpenSession | null): SessionState {
  if (persisted === null) return initialState;
  return {
    kind: "finished",
    sessionId: persisted.sessionId,
    operatorId: persisted.operatorId,
    machineId: persisted.machineId,
    startedAtMs: persisted.startedAtMs,
    endedAtMs: Math.max(persisted.lastCheckpointAtMs, persisted.startedAtMs),
    liters: persisted.liters,
    endReason: "interrupted",
  };
}
