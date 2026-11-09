import type { Locale } from "./format.ts";

const STORAGE_KEY = "agriflow.lang";

export const DEFAULT_LOCALE: Locale = "en";

function isLocale(value: string | null): value is Locale {
  return value === "en" || value === "es";
}

/**
 * The language to start in: an explicit `?lang=` wins, then the saved choice, then English.
 * Storage may be unavailable (private mode, blocked site data), so every access is guarded.
 */
export function initialLocale(
  search: string,
  storage?: Pick<Storage, "getItem"> | undefined,
): Locale {
  const fromQuery = new URLSearchParams(search).get("lang");
  if (isLocale(fromQuery)) return fromQuery;
  try {
    const saved = storage?.getItem(STORAGE_KEY) ?? null;
    if (isLocale(saved)) return saved;
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_LOCALE;
}

export function saveLocale(locale: Locale, storage?: Pick<Storage, "setItem"> | undefined): void {
  try {
    storage?.setItem(STORAGE_KEY, locale);
  } catch {
    // The choice then only lasts until the page is reloaded.
  }
}

export function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
