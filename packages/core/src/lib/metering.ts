import type { Settings } from "./settings.ts";

export type PulseDelta =
  | { readonly ok: true; readonly pulses: number }
  | { readonly ok: false; readonly reason: "counter_reset" | "invalid_counter" };

/**
 * Pulses added between two readings of a monotonically increasing hardware counter.
 * A counter that goes backwards is an anomaly, never a negative delta.
 */
export function deltaPulses(previous: number, current: number): PulseDelta {
  if (!Number.isSafeInteger(previous) || !Number.isSafeInteger(current)) {
    return { ok: false, reason: "invalid_counter" };
  }
  if (previous < 0 || current < 0) return { ok: false, reason: "invalid_counter" };
  if (current < previous) return { ok: false, reason: "counter_reset" };
  return { ok: true, pulses: current - previous };
}

/** Liters for a number of pulses using the device calibration factor. */
export function pulsesToLiters(pulses: number, settings: Pick<Settings, "litersPerPulse">): number {
  if (!Number.isFinite(pulses) || pulses < 0) {
    throw new RangeError("pulses must be a non-negative finite number");
  }
  return pulses * settings.litersPerPulse;
}

/**
 * Flow rate in liters per minute over an interval. Zero when no liters were measured.
 * Liters measured over an empty or reversed interval are an infinite rate, never zero.
 */
export function flowRateLitersPerMinute(liters: number, fromMs: number, toMs: number): number {
  const elapsedMs = toMs - fromMs;
  if (!(liters > 0)) return 0;
  if (!(elapsedMs > 0)) return Number.POSITIVE_INFINITY;
  return (liters * 60_000) / elapsedMs;
}

/** True if the measured rate is non-negative and within what the pump can physically deliver. */
export function isPlausibleFlow(
  litersPerMinute: number,
  settings: Pick<Settings, "maxFlowLitersPerMinute">,
): boolean {
  return (
    Number.isFinite(litersPerMinute) &&
    litersPerMinute >= 0 &&
    litersPerMinute <= settings.maxFlowLitersPerMinute
  );
}
