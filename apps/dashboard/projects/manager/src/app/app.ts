import {
  browserStorage,
  deviceHealth,
  formatAge,
  formatDateTime,
  formatLiters,
  LanguageSwitch,
  type Locale,
  saveLocale,
} from "@agriflow/shared";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from "@angular/core";
import { type Bar, BarChart } from "./bar-chart";
import { FARM_TIME_ZONE, LOCALE, ManagerStore, PAGE_SIZE, periodDayKeys } from "./manager-store";
import { messagesFor } from "./messages";

/** A controller that has been quiet this long may be offline or simply idle. */
const STALE_AFTER_MS = 6 * 3_600_000;

@Component({
  selector: "app-root",
  imports: [BarChart, LanguageSwitch],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./app.html",
  styleUrl: "./app.css",
})
export class App {
  protected readonly store = inject(ManagerStore);
  protected readonly locale = signal(inject(LOCALE));
  protected readonly m = computed(() => messagesFor(this.locale()));

  constructor() {
    effect(() => {
      document.documentElement.lang = this.locale();
    });
  }

  protected setLocale(locale: Locale): void {
    this.locale.set(locale);
    saveLocale(locale, browserStorage());
  }
  protected readonly periods = [7, 30, 90];
  protected readonly token = signal("");

  protected readonly data = this.store.data;
  protected readonly error = computed(() => {
    const kind = this.store.error();
    return kind === null ? null : this.m().errors[kind];
  });

  protected readonly totals = computed(() => {
    const d = this.data();
    if (d === null) return null;
    const liters = d.daily.reduce((sum, row) => sum + row.liters, 0);
    const sessions = d.daily.reduce((sum, row) => sum + row.sessions, 0);
    return {
      liters: this.liters(liters, 0),
      sessions: String(sessions),
      average: this.liters(sessions === 0 ? 0 : liters / sessions),
      machines: String(d.machines.length),
    };
  });

  /** One bar per day of the period, including days with nothing dispensed. */
  protected readonly bars = computed<Bar[]>(() => {
    const d = this.data();
    if (d === null) return [];
    const byDay = new Map(d.daily.map((row) => [row.key, row.liters]));
    return periodDayKeys(d.loadedAtMs, d.days).map((key) => ({
      label:
        this.locale() === "es"
          ? `${key.slice(8, 10)}/${key.slice(5, 7)}`
          : `${key.slice(5, 7)}/${key.slice(8, 10)}`,
      value: byDay.get(key) ?? 0,
    }));
  });

  protected readonly chartSummary = computed(() => {
    const t = this.totals();
    return t === null ? "" : `${this.m().dailyTitle}: ${t.liters}`;
  });

  protected readonly maxMachine = computed(() =>
    Math.max(1, ...(this.data()?.machines ?? []).map((r) => r.liters)),
  );
  protected readonly maxOperator = computed(() =>
    Math.max(1, ...(this.data()?.operators ?? []).map((r) => r.liters)),
  );

  protected readonly devices = computed(() => {
    const d = this.data();
    if (d === null) return [];
    return d.devices.map((device) => {
      const health = deviceHealth(device.lastReceivedAtMs, d.loadedAtMs, STALE_AFTER_MS);
      return {
        ...device,
        health,
        label: this.m().health[health],
        since:
          device.lastReceivedAtMs === null
            ? ""
            : this.m().ago(formatAge(d.loadedAtMs - device.lastReceivedAtMs)),
      };
    });
  });

  protected readonly rows = computed(() =>
    (this.data()?.page.items ?? []).map((t) => ({
      id: t.sessionId,
      date: formatDateTime(t.startedAtMs, this.locale(), FARM_TIME_ZONE),
      machine: t.equipmentNumber ?? t.machineId,
      operator: t.operatorId,
      liters: this.liters(t.liters),
      reason: this.m().endReasons[t.endReason] ?? t.endReason,
    })),
  );

  protected readonly paging = computed(() => {
    const page = this.data()?.page;
    if (page === undefined || page.total === 0) return null;
    const from = page.offset + 1;
    const to = Math.min(page.offset + PAGE_SIZE, page.total);
    return {
      text: this.m().pageOf(from, to, page.total),
      hasPrevious: page.offset > 0,
      hasNext: to < page.total,
    };
  });

  protected liters(value: number, digits = 1): string {
    return formatLiters(value, this.locale(), digits);
  }

  protected readonly chartFormat = computed(() => {
    const locale = this.locale();
    return (value: number): string => formatLiters(value, locale, 0);
  });

  protected async signIn(event: Event): Promise<void> {
    event.preventDefault();
    if (this.token() === "") return;
    await this.store.signIn(this.token());
    // The key is not kept in the page once it has been used.
    this.token.set("");
  }

  protected pick(event: Event): string | undefined {
    const value = (event.target as HTMLSelectElement).value;
    return value === "" ? undefined : value;
  }
}
