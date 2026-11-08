import type { ButtonName, Hardware, Unsubscribe } from "./interfaces.ts";

export interface SimulatorOptions {
  /** Flow meter calibration of the simulated meter. */
  readonly pulsesPerLiter?: number;
  /** Flow rate while the pump is powered. */
  readonly flowLitersPerMinute?: number;
}

class Emitter<T> {
  readonly #listeners = new Set<(value: T) => void>();

  subscribe(listener: (value: T) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(value: T): void {
    for (const listener of [...this.#listeners]) listener(value);
  }
}

/**
 * In-memory hardware for development and tests. Time is driven explicitly with `advance`, so
 * runs are deterministic. Like the real wiring, the E-stop cuts pump power regardless of the
 * relay command, and the relay starts off.
 */
export class SimulatedHardware implements Hardware {
  readonly #pulsesPerLiter: number;
  readonly #flowLitersPerMinute: number;
  readonly #scans = new Emitter<string>();
  readonly #estopChanges = new Emitter<boolean>();
  readonly #presses = new Emitter<ButtonName>();
  #commanded = false;
  #estopEngaged = false;
  #pulses = 0;
  #pulseRemainder = 0;
  #closed = false;

  constructor(options: SimulatorOptions = {}) {
    const pulsesPerLiter = options.pulsesPerLiter ?? 100;
    const flowLitersPerMinute = options.flowLitersPerMinute ?? 60;
    for (const [name, value] of [
      ["pulsesPerLiter", pulsesPerLiter],
      ["flowLitersPerMinute", flowLitersPerMinute],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive finite number`);
      }
    }
    this.#pulsesPerLiter = pulsesPerLiter;
    this.#flowLitersPerMinute = flowLitersPerMinute;
  }

  readonly relay = {
    enable: (): void => {
      if (this.#closed) return;
      this.#commanded = true;
    },
    disable: (): void => {
      this.#commanded = false;
    },
    isEnabled: (): boolean => this.#commanded,
  };

  readonly meter = {
    readPulses: (): number => this.#pulses,
  };

  readonly reader = {
    onScan: (listener: (uid: string) => void): Unsubscribe => this.#scans.subscribe(listener),
  };

  readonly estop = {
    isEngaged: (): boolean => this.#estopEngaged,
    onChange: (listener: (engaged: boolean) => void): Unsubscribe =>
      this.#estopChanges.subscribe(listener),
  };

  readonly buttons = {
    onPress: (listener: (button: ButtonName) => void): Unsubscribe =>
      this.#presses.subscribe(listener),
  };

  close(): void {
    this.#commanded = false;
    this.#closed = true;
  }

  // --- test and development controls ------------------------------------------------------

  /** True while fuel is actually flowing: commanded on and the E-stop is not engaged. */
  pumpPowered(): boolean {
    return this.#commanded && !this.#estopEngaged;
  }

  scan(uid: string): void {
    this.#scans.emit(uid);
  }

  press(button: ButtonName): void {
    this.#presses.emit(button);
  }

  engageEstop(): void {
    if (this.#estopEngaged) return;
    this.#estopEngaged = true;
    this.#estopChanges.emit(true);
  }

  releaseEstop(): void {
    if (!this.#estopEngaged) return;
    this.#estopEngaged = false;
    this.#estopChanges.emit(false);
  }

  /** Let simulated time pass. Pulses accrue only while the pump is powered. */
  advance(ms: number): void {
    if (!this.pumpPowered() || !(ms > 0)) return;
    const exact =
      (this.#flowLitersPerMinute / 60) * (ms / 1000) * this.#pulsesPerLiter + this.#pulseRemainder;
    const whole = Math.floor(exact);
    this.#pulses += whole;
    this.#pulseRemainder = exact - whole;
  }
}
