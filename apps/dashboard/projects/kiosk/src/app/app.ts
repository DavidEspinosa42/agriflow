import {
  browserStorage,
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
import { Keypad } from "./keypad";
import { KioskStore, LOCALE } from "./kiosk-store";
import { endReasonText, messagesFor, noticeText } from "./messages";

@Component({
  selector: "app-root",
  imports: [Keypad, LanguageSwitch],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./app.html",
  styleUrl: "./app.css",
})
export class App {
  readonly #store = inject(KioskStore);
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

  protected readonly snapshot = this.#store.snapshot;
  protected readonly online = computed(() => this.#store.connection() === "open");
  protected readonly connected = computed(() => this.snapshot() !== null);
  protected readonly equipment = signal("");

  /** The screen mode, which also drives the colour of the whole page. */
  protected readonly mode = computed(() => {
    const s = this.snapshot();
    if (s === null) return "waiting";
    if (s.estopEngaged) return "stopped";
    return s.phase;
  });

  protected readonly notice = computed(() => {
    const s = this.snapshot();
    return s === null ? null : noticeText(s.notice, this.m());
  });

  protected readonly liters = computed(() =>
    formatLiters(this.snapshot()?.liters ?? 0, this.locale()),
  );
  protected readonly endReason = computed(() =>
    endReasonText(this.snapshot()?.endReason ?? null, this.m()),
  );

  protected selectMachine(equipmentNumber: string): void {
    if (this.#store.send({ type: "select_machine", equipmentNumber })) this.equipment.set("");
  }

  protected start(): void {
    this.#store.send({ type: "start" });
  }

  protected stop(): void {
    this.#store.send({ type: "stop" });
  }

  protected dismiss(): void {
    this.#store.send({ type: "dismiss" });
  }
}
