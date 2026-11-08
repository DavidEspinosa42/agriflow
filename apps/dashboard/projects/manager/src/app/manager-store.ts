import type {
  ConsumptionRowDto,
  DeviceStatusDto,
  StoredTransactionDto,
  TransactionPage,
} from "@agriflow/core";
import { ApiError, type ApiErrorKind, type Locale, ManagerApi } from "@agriflow/shared";
import { Injectable, InjectionToken, inject, signal } from "@angular/core";

export const PAGE_SIZE = 10;
/** Argentina has no daylight saving time. */
export const FARM_TIME_ZONE = "America/Argentina/Buenos_Aires";
export const FARM_UTC_OFFSET_MINUTES = -180;
const DAY_MS = 86_400_000;

export type ApiFactory = (token: string) => ManagerApi;

export const API_FACTORY = new InjectionToken<ApiFactory>("apiFactory", {
  factory: () => (token) => new ManagerApi({ baseUrl: "", token }),
});

export const NOW = new InjectionToken<() => number>("now", { factory: () => () => Date.now() });

export const LOCALE = new InjectionToken<Locale>("locale", {
  factory: () => (new URLSearchParams(location.search).get("lang") === "en" ? "en" : "es"),
});

export interface Filters {
  readonly machineId: string | undefined;
  readonly operatorId: string | undefined;
  readonly offset: number;
}

export interface Dashboard {
  readonly days: number;
  readonly daily: readonly ConsumptionRowDto[];
  readonly machines: readonly ConsumptionRowDto[];
  readonly operators: readonly ConsumptionRowDto[];
  readonly devices: readonly DeviceStatusDto[];
  readonly page: TransactionPage;
  readonly loadedAtMs: number;
}

/** Start of the local day, `days - 1` days back, so "7 days" includes today. */
export function periodStart(nowMs: number, days: number): number {
  const local = nowMs + FARM_UTC_OFFSET_MINUTES * 60_000;
  const dayStart = Math.floor(local / DAY_MS) * DAY_MS - FARM_UTC_OFFSET_MINUTES * 60_000;
  return dayStart - (days - 1) * DAY_MS;
}

/** The local calendar dates (YYYY-MM-DD) of the period, oldest first, ending today. */
export function periodDayKeys(nowMs: number, days: number): string[] {
  const today = Math.floor((nowMs + FARM_UTC_OFFSET_MINUTES * 60_000) / DAY_MS);
  return Array.from({ length: days }, (_, i) =>
    new Date((today - days + 1 + i) * DAY_MS).toISOString().slice(0, 10),
  );
}

/**
 * Manager session state. The access key lives only in memory: reloading the page signs out,
 * which is the safe default for a shared farm computer.
 */
@Injectable({ providedIn: "root" })
export class ManagerStore {
  readonly #factory = inject(API_FACTORY);
  readonly #now = inject(NOW);
  #api: ManagerApi | null = null;
  /** Incremented per load and per sign-out, so a slow older response cannot overwrite a newer one. */
  #generation = 0;

  readonly signedIn = signal(false);
  readonly loading = signal(false);
  readonly error = signal<ApiErrorKind | null>(null);
  readonly data = signal<Dashboard | null>(null);
  readonly days = signal(30);
  readonly filters = signal<Filters>({ machineId: undefined, operatorId: undefined, offset: 0 });

  /** Check the key against the server and load the dashboard. */
  async signIn(token: string): Promise<boolean> {
    const api = this.#factory(token.trim());
    this.#api = api;
    this.error.set(null);
    const ok = await this.#load();
    if (ok) this.signedIn.set(true);
    // A superseded load is neither success nor failure; only a real error discards the key.
    else if (this.error() !== null) this.#api = null;
    return ok;
  }

  signOut(): void {
    this.#api = null;
    this.#generation++;
    this.loading.set(false);
    this.signedIn.set(false);
    this.data.set(null);
    this.error.set(null);
    this.filters.set({ machineId: undefined, operatorId: undefined, offset: 0 });
  }

  refresh(): Promise<boolean> {
    return this.#load();
  }

  setDays(days: number): Promise<boolean> {
    this.days.set(days);
    // The choices depend on the period, so a selection made for another one is dropped.
    this.filters.set({ machineId: undefined, operatorId: undefined, offset: 0 });
    return this.#load();
  }

  setFilter(patch: Partial<Pick<Filters, "machineId" | "operatorId">>): Promise<boolean> {
    this.filters.update((f) => ({ ...f, ...patch, offset: 0 }));
    return this.#load();
  }

  setOffset(offset: number): Promise<boolean> {
    this.filters.update((f) => ({ ...f, offset: Math.max(0, offset) }));
    return this.#load();
  }

  async #load(): Promise<boolean> {
    const api = this.#api;
    if (api === null) return false;
    const generation = ++this.#generation;
    const now = this.#now();
    const days = this.days();
    const from = periodStart(now, days);
    const f = this.filters();
    this.loading.set(true);
    try {
      const [daily, machines, operators, devices, page] = await Promise.all([
        api.consumption({ groupBy: "day", from, utcOffsetMinutes: FARM_UTC_OFFSET_MINUTES }),
        api.machines({ from }),
        api.operators({ from }),
        api.devices(),
        api.transactions({
          from,
          machineId: f.machineId,
          operatorId: f.operatorId,
          limit: PAGE_SIZE,
          offset: f.offset,
        }),
      ]);
      if (generation !== this.#generation) return false;
      this.data.set({
        days,
        daily: daily.rows,
        machines: machines.items,
        operators: operators.items,
        devices: devices.items,
        page,
        loadedAtMs: now,
      });
      this.error.set(null);
      return true;
    } catch (error) {
      if (generation !== this.#generation) return false;
      const kind = error instanceof ApiError ? error.kind : "server";
      // A rejected key ends the session; the message must survive the sign-out.
      if (kind === "unauthorized") this.signOut();
      this.error.set(kind);
      return false;
    } finally {
      if (generation === this.#generation) this.loading.set(false);
    }
  }
}

export type { StoredTransactionDto };
