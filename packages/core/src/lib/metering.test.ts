import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  deltaPulses,
  flowRateLitersPerMinute,
  isPlausibleFlow,
  pulsesToLiters,
} from "./metering.ts";

describe("metering", () => {
  it("computes non-negative deltas for increasing counters", () => {
    fc.assert(
      fc.property(fc.nat(1_000_000), fc.nat(1_000_000), (a, b) => {
        const [prev, curr] = a <= b ? [a, b] : [b, a];
        expect(deltaPulses(prev, curr)).toEqual({ ok: true, pulses: curr - prev });
      }),
    );
  });

  it("flags a counter that goes backwards instead of returning a negative delta", () => {
    expect(deltaPulses(100, 40)).toEqual({ ok: false, reason: "counter_reset" });
    expect(deltaPulses(-1, 5)).toEqual({ ok: false, reason: "invalid_counter" });
    expect(deltaPulses(1.5, 5)).toEqual({ ok: false, reason: "invalid_counter" });
  });

  it("converts pulses linearly and monotonically", () => {
    fc.assert(
      fc.property(fc.nat(100_000), fc.nat(100_000), (a, b) => {
        const s = { litersPerPulse: 0.01 };
        if (a <= b) expect(pulsesToLiters(a, s)).toBeLessThanOrEqual(pulsesToLiters(b, s));
        expect(pulsesToLiters(a + b, s)).toBeCloseTo(
          pulsesToLiters(a, s) + pulsesToLiters(b, s),
          6,
        );
      }),
    );
  });

  it("rejects invalid pulse counts", () => {
    expect(() => pulsesToLiters(-1, { litersPerPulse: 0.01 })).toThrow(RangeError);
    expect(() => pulsesToLiters(Number.NaN, { litersPerPulse: 0.01 })).toThrow(RangeError);
  });

  it("computes flow rate and judges plausibility", () => {
    expect(flowRateLitersPerMinute(10, 0, 30_000)).toBeCloseTo(20);
    expect(flowRateLitersPerMinute(10, 5, 5)).toBe(0);
    expect(flowRateLitersPerMinute(10, 10, 5)).toBe(0);
    expect(isPlausibleFlow(100, { maxFlowLitersPerMinute: 300 })).toBe(true);
    expect(isPlausibleFlow(301, { maxFlowLitersPerMinute: 300 })).toBe(false);
    expect(isPlausibleFlow(-100, { maxFlowLitersPerMinute: 300 })).toBe(false);
    expect(isPlausibleFlow(Number.NaN, { maxFlowLitersPerMinute: 300 })).toBe(false);
  });
});
