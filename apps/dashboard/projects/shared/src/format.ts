export type Locale = "es" | "en";

const TAGS: Record<Locale, string> = { es: "es-AR", en: "en-US" };

/** 84.3 becomes "84,3 L" in Spanish and "84.3 L" in English. */
export function formatLiters(liters: number, locale: Locale = "en", digits = 1): string {
  return `${new Intl.NumberFormat(TAGS[locale], {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(liters)} L`;
}

/**
 * Date and time in the farm's time zone, with the month spelled out so day and month cannot be
 * mixed up: "Mar 9, 2026, 10:00 PM" in English, "9 mar 2026, 22:00" in Spanish.
 */
export function formatDateTime(ms: number, locale: Locale = "en", timeZone?: string): string {
  return new Intl.DateTimeFormat(TAGS[locale], {
    dateStyle: "medium",
    timeStyle: "short",
    hourCycle: locale === "es" ? "h23" : "h12",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(ms);
}

/** Whole minutes or hours or days elapsed, as short text such as "3 min" or "2 h". */
export function formatAge(elapsedMs: number): string {
  const minutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

export type DeviceHealth = "never" | "ok" | "stale";

/**
 * A controller that has not synced for a while may be offline, or may simply have had nothing to
 * send. The dashboard shows it as "stale" rather than claiming it is down.
 */
export function deviceHealth(
  lastReceivedAtMs: number | null,
  nowMs: number,
  staleAfterMs: number,
): DeviceHealth {
  if (lastReceivedAtMs === null) return "never";
  return nowMs - lastReceivedAtMs > staleAfterMs ? "stale" : "ok";
}
