import type { Hardware, Unsubscribe } from "../hardware/interfaces.ts";
import type { DispensingService, Snapshot } from "./dispensing-service.ts";

export interface RuntimeOptions {
  readonly service: DispensingService;
  readonly hardware: Hardware;
  /** How often the service is ticked. Metering and timeouts advance on each tick. */
  readonly tickIntervalMs?: number;
  /** Called with errors from event handlers. Must not log fob UIDs or secrets. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Connects the hardware events and a timer to the dispensing service and publishes snapshots
 * whenever they change. Any exception in a handler switches the pump off before it is reported.
 */
export class ControllerRuntime {
  readonly #o: RuntimeOptions;
  readonly #listeners = new Set<(snapshot: Snapshot) => void>();
  readonly #unsubscribe: Unsubscribe[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #last = "";
  #open = false;

  constructor(options: RuntimeOptions) {
    this.#o = options;
  }

  /**
   * Boots the service and starts accepting input. Commands stay rejected until every listener
   * and the safety timer are in place; a failure part-way rolls everything back and rethrows.
   */
  start(): void {
    if (this.#open) return;
    const { service, hardware } = this.#o;
    // A session left unstored by an earlier shutdown must be written before boot recovers it.
    if (!service.flush()) {
      throw new Error("cannot start: the previous session has not been stored yet");
    }
    service.boot();
    try {
      this.#unsubscribe.push(
        hardware.reader.onScan((uid) => this.run(() => service.handleScan(uid))),
      );
      this.#unsubscribe.push(
        hardware.estop.onChange((engaged) => this.run(() => service.handleEstop(engaged))),
      );
      this.#unsubscribe.push(
        hardware.buttons.onPress((button) =>
          this.run(() => (button === "start" ? service.start() : service.stop())),
        ),
      );
      const timer = setInterval(
        () => this.run(() => service.tick()),
        this.#o.tickIntervalMs ?? 250,
      );
      timer.unref();
      this.#timer = timer;
      this.#open = true;
    } catch (error) {
      this.#teardown();
      throw error;
    }
    this.#publish();
  }

  /**
   * Rejects commands, switches the pump off, then ends any active session so its final liters
   * are recorded. Cleanup failures cannot prevent the pump from being switched off. Throws if the
   * final session could not be stored; call stop again to retry before closing the database.
   */
  stop(): void {
    this.#open = false;
    this.#o.hardware.relay.disable();
    try {
      this.#teardown();
    } finally {
      // The shutdown action bypasses the command gate.
      this.#guarded(() => this.#o.service.stop());
      this.#o.hardware.relay.disable();
    }
    if (!this.#o.service.flush()) {
      throw new Error("shutdown incomplete: the final session could not be stored");
    }
  }

  #teardown(): void {
    this.#open = false;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    for (const off of this.#unsubscribe.splice(0)) {
      try {
        off();
      } catch (error) {
        this.#o.onError?.(error);
      }
    }
    this.#o.hardware.relay.disable();
  }

  /** Subscribe to snapshot changes. The current snapshot is delivered immediately. */
  subscribe(listener: (snapshot: Snapshot) => void): Unsubscribe {
    this.#listeners.add(listener);
    try {
      listener(this.#o.service.snapshot());
    } catch (error) {
      this.#failSafe(error);
    }
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Run a service action; on any exception the pump is disabled and the error reported. */
  run(action: () => void): void {
    if (!this.#open) return;
    this.#guarded(action);
  }

  #guarded(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.#failSafe(error);
    }
    this.#publish();
  }

  #failSafe(error: unknown): void {
    try {
      this.#o.hardware.relay.disable();
      this.#o.service.failSafe();
    } catch {
      // The relay is already off; nothing more can be done here.
    } finally {
      this.#o.onError?.(error);
    }
  }

  #publish(): void {
    let snapshot: Snapshot;
    let json: string;
    try {
      snapshot = this.#o.service.snapshot();
      json = JSON.stringify(snapshot);
    } catch (error) {
      // Reading hardware status failed: the pump state cannot be trusted, so switch it off.
      this.#failSafe(error);
      return;
    }
    if (json === this.#last) return;
    this.#last = json;
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        this.#o.onError?.(error);
      }
    }
  }
}
