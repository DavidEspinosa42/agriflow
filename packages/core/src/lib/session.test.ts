import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Authorization } from "./authorization.ts";
import type { MachineId, OperatorId, SessionId } from "./schemas.ts";
import {
  initialState,
  pumpEnabled,
  recover,
  reduce,
  type SessionEvent,
  type SessionState,
} from "./session.ts";

const settings = { maxSessionLiters: 100, idleTimeoutSeconds: 10 };
const sid = "123e4567-e89b-42d3-a456-426614174000" as SessionId;
const auth = (grantedAtMs: number, ttlMs = 60_000): Authorization => ({
  operatorId: "op-1" as OperatorId,
  machineId: "m1" as MachineId,
  grantedAtMs,
  expiresAtMs: grantedAtMs + ttlMs,
});

const MAX_T = 200_000;
const time = fc.nat({ max: MAX_T });

const eventArb: fc.Arbitrary<SessionEvent> = fc.oneof(
  time.map((t): SessionEvent => ({ type: "authorized", authorization: auth(t) })),
  time.map((t): SessionEvent => ({ type: "start", nowMs: t, sessionId: sid })),
  fc
    .tuple(time, fc.double({ min: -5, max: 30, noNaN: true }))
    .map(([t, liters]): SessionEvent => ({ type: "flow", nowMs: t, liters })),
  time.map((t): SessionEvent => ({ type: "tick", nowMs: t })),
  time.map((t): SessionEvent => ({ type: "stop", nowMs: t })),
  time.map((t): SessionEvent => ({ type: "fault", nowMs: t })),
  time.map((t): SessionEvent => ({ type: "estop", nowMs: t })),
  fc.constant<SessionEvent>({ type: "reset" }),
);

function run(events: readonly SessionEvent[]): SessionState[] {
  const states: SessionState[] = [initialState];
  for (const e of events) {
    states.push(reduce(states[states.length - 1] ?? initialState, e, settings));
  }
  return states;
}

describe("session state machine", () => {
  it("boots with the pump disabled", () => {
    expect(pumpEnabled(initialState)).toBe(false);
  });

  it("never enables the pump without a prior authorization event (invariant 1)", () => {
    fc.assert(
      fc.property(
        fc.array(
          eventArb.filter((e) => e.type !== "authorized"),
          { maxLength: 40 },
        ),
        (events) => {
          for (const s of run(events)) expect(pumpEnabled(s)).toBe(false);
        },
      ),
    );
  });

  it("enables the pump only through start from a valid authorization", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 40 }), (events) => {
        const states = run(events);
        for (let i = 1; i < states.length; i++) {
          const before = states[i - 1] ?? initialState;
          const after = states[i] ?? initialState;
          const event = events[i - 1];
          if (!pumpEnabled(before) && pumpEnabled(after)) {
            expect(event?.type).toBe("start");
            expect(before.kind).toBe("authorized");
            if (before.kind === "authorized" && event?.type === "start") {
              expect(event.nowMs).toBeGreaterThanOrEqual(before.authorization.grantedAtMs);
              expect(event.nowMs).toBeLessThan(before.authorization.expiresAtMs);
            }
          }
        }
      }),
    );
  });

  it("leaves the pump off after stop, fault or estop", () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { maxLength: 40 }),
        fc.constantFrom("stop", "fault", "estop"),
        time,
        (events, type, nowMs) => {
          const states = run([...events, { type, nowMs }]);
          expect(pumpEnabled(states[states.length - 1] ?? initialState)).toBe(false);
        },
      ),
    );
  });

  it("never decreases liters within a session", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 60 }), (events) => {
        const states = run(events);
        for (let i = 1; i < states.length; i++) {
          const a = states[i - 1] ?? initialState;
          const b = states[i] ?? initialState;
          if (
            (a.kind === "dispensing" || a.kind === "finished") &&
            (b.kind === "dispensing" || b.kind === "finished") &&
            a.sessionId === b.sessionId
          ) {
            expect(b.liters).toBeGreaterThanOrEqual(a.liters);
          }
        }
      }),
    );
  });

  it("faults and disables the pump on an invalid flow reading", () => {
    for (const liters of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const states = run([
        { type: "authorized", authorization: auth(0) },
        { type: "start", nowMs: 1, sessionId: sid },
        { type: "flow", nowMs: 2, liters },
      ]);
      expect(states[3]).toMatchObject({ kind: "finished", endReason: "fault" });
      expect(pumpEnabled(states[3] ?? initialState)).toBe(false);
    }
  });

  it("ignores flow readings that predate the session", () => {
    const states = run([
      { type: "authorized", authorization: auth(0) },
      { type: "start", nowMs: 1_000, sessionId: sid },
      { type: "flow", nowMs: 500, liters: 10 },
    ]);
    expect(states[3]).toMatchObject({ kind: "dispensing", liters: 0 });
  });

  it("never ends a session before its start or its last recorded flow", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 60 }), (events) => {
        let last: SessionState = initialState;
        for (const state of run(events)) {
          if (state.kind === "dispensing") last = state;
          if (
            state.kind === "finished" &&
            last.kind === "dispensing" &&
            last.sessionId === state.sessionId
          ) {
            expect(state.endedAtMs).toBeGreaterThanOrEqual(state.startedAtMs);
            expect(state.endedAtMs).toBeGreaterThanOrEqual(last.lastFlowAtMs);
          }
        }
      }),
    );
  });

  it("ends the session at the maximum liters", () => {
    const states = run([
      { type: "authorized", authorization: auth(0) },
      { type: "start", nowMs: 1, sessionId: sid },
      { type: "flow", nowMs: 2, liters: 100 },
    ]);
    expect(states[3]).toMatchObject({ kind: "finished", endReason: "max_liters" });
  });

  it("ends the session after the idle timeout", () => {
    const states = run([
      { type: "authorized", authorization: auth(0) },
      { type: "start", nowMs: 1_000, sessionId: sid },
      { type: "tick", nowMs: 10_999 },
      { type: "tick", nowMs: 11_000 },
    ]);
    expect(states[3]).toMatchObject({ kind: "dispensing" });
    expect(states[4]).toMatchObject({ kind: "finished", endReason: "idle_timeout" });
  });

  it("lapses an authorization that was not used in time", () => {
    const states = run([
      { type: "authorized", authorization: auth(0, 5_000) },
      { type: "start", nowMs: 5_000, sessionId: sid },
    ]);
    expect(states[2]).toEqual(initialState);
  });

  it("recovers an unfinished session as interrupted with the pump off", () => {
    const s = recover({
      sessionId: sid,
      operatorId: "op-1" as OperatorId,
      machineId: "m1" as MachineId,
      startedAtMs: 10,
      lastCheckpointAtMs: 50,
      liters: 12.5,
    });
    expect(s).toMatchObject({ kind: "finished", endReason: "interrupted", liters: 12.5 });
    expect(pumpEnabled(s)).toBe(false);
    expect(recover(null)).toEqual(initialState);
  });
});
