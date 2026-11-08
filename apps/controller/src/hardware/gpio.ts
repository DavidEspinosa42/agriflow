import { execFile, execFileSync, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type {
  ButtonName,
  Buttons,
  EstopInput,
  FlowMeter,
  Hardware,
  PumpRelay,
  Unsubscribe,
} from "./interfaces.ts";
import { openWedgeDevice, type WedgeReader } from "./wedge-reader.ts";

/**
 * Raspberry Pi GPIO through the libgpiod v2 command line tools (`gpioset`, `gpiomon`, `gpioget`).
 * This avoids a native Node addon and works on every Pi model, including the Pi 5.
 *
 * Fail-safe design: the relay line is held by one `gpioset --interactive` process that reads
 * commands from a pipe. If the controller exits or crashes the pipe closes, `gpioset` exits and
 * releases the line, and the external pull-down returns the relay to off.
 */
export interface GpioConfig {
  /** For example "gpiochip0". */
  readonly chip: string;
  readonly relayLine: number;
  readonly meterLine: number;
  readonly estopLine: number;
  readonly startButtonLine: number;
  readonly stopButtonLine: number;
  /** Which level means "stopped" for the normally-closed E-stop loop. Default "high" (loop open). */
  readonly estopEngagedLevel?: "high" | "low";
  /** How often the emergency stop input is read. Default 250 ms. */
  readonly estopPollMs?: number;
  /** Path of the keyboard-wedge reader, for example /dev/input/by-id/usb-...-event-kbd. */
  readonly rfidDevice: string;
}

export interface ChildLike {
  readonly stdin: Pick<Writable, "write" | "end" | "on"> | null;
  readonly stdout: Pick<Readable, "on"> | null;
  on(event: "exit" | "error", listener: () => void): unknown;
  kill(): unknown;
}

export interface GpioDeps {
  readonly spawn: (command: string, args: string[]) => ChildLike;
  /** Run a command to completion and return its standard output. */
  readonly run: (command: string, args: string[]) => string;
  /** Like `run`, without blocking the event loop. */
  readonly read: (command: string, args: string[]) => Promise<string>;
  readonly openReader: (
    path: string,
    onError: (error: Error) => void,
  ) => Pick<WedgeReader, "onScan" | "close">;
  readonly onError?: (error: Error) => void;
}

export const gpioDefaults: GpioDeps = {
  spawn: (command, args) =>
    spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] }) as unknown as ChildLike,
  run: (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 5000 }),
  read: (command, args) =>
    new Promise((resolve, reject) => {
      execFile(command, args, { encoding: "utf8", timeout: 2000 }, (error, stdout) =>
        error === null ? resolve(stdout) : reject(error),
      );
    }),
  openReader: (path, onError) => openWedgeDevice(path, { onError }),
};

/** Collect complete lines from a stream; partial lines wait for the rest. */
function onLines(stream: Pick<Readable, "on"> | null, handle: (line: string) => void): void {
  let rest = "";
  stream?.on("data", (chunk: Buffer | string) => {
    rest += chunk.toString();
    let newline = rest.indexOf("\n");
    while (newline >= 0) {
      handle(rest.slice(0, newline).trim());
      rest = rest.slice(newline + 1);
      newline = rest.indexOf("\n");
    }
  });
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

/** Throws unless the installed gpioset can run interactively (a build option in libgpiod). */
export function assertGpioTools(run: GpioDeps["run"] = gpioDefaults.run): void {
  let help: string;
  try {
    help = run("gpioset", ["--help"]);
  } catch {
    throw new Error("gpioset was not found; install libgpiod v2 tools (apt install gpiod)");
  }
  if (!help.includes("--interactive")) {
    throw new Error(
      "this gpioset has no --interactive mode; libgpiod v2.x built with it is required",
    );
  }
}

export class GpioHardware implements Hardware {
  readonly relay: PumpRelay;
  readonly meter: FlowMeter;
  readonly reader: Pick<WedgeReader, "onScan" | "close">;
  readonly estop: EstopInput;
  readonly buttons: Buttons;
  readonly #children: ChildLike[] = [];
  readonly #ready: Promise<void>;
  readonly #estopTimer: ReturnType<typeof setInterval>;
  readonly #relayChild: ChildLike;

  constructor(config: GpioConfig, deps: GpioDeps = gpioDefaults) {
    const fail = (error: Error) => deps.onError?.(error);
    // Once any monitor has died, dispensing stays blocked until the controller restarts: with a
    // dead stop button or meter the pump could not be supervised properly.
    let degraded = false;
    const track = (child: ChildLike, name: string): { alive: () => boolean } => {
      let alive = true;
      const died = () => {
        degraded = true;
        if (alive) fail(new Error(`${name} process stopped`));
        alive = false;
      };
      child.on("exit", died);
      child.on("error", died);
      this.#children.push(child);
      return { alive: () => alive };
    };

    // --- relay ---------------------------------------------------------------------------
    const relayChild = deps.spawn("gpioset", [
      "--interactive",
      "--chip",
      config.chip,
      `${config.relayLine}=inactive`,
    ]);
    this.#relayChild = relayChild;
    // Interactive gpioset prints prompts. An unread pipe would fill and block later commands.
    relayChild.stdout?.on("data", () => undefined);
    const relayState = track(relayChild, "relay");
    // A write to a dead process raises an asynchronous error; it must not crash the controller.
    relayChild.stdin?.on("error", () => undefined);
    let commanded = false;
    this.relay = {
      enable: () => {
        if (!relayState.alive() || relayChild.stdin === null) {
          throw new Error("the relay controller is not running");
        }
        if (degraded) throw new Error("a hardware monitor has stopped; restart the controller");
        relayChild.stdin.write(`set ${config.relayLine}=1\n`);
        commanded = true;
      },
      disable: () => {
        commanded = false;
        try {
          if (relayState.alive()) relayChild.stdin?.write(`set ${config.relayLine}=0\n`);
        } catch {
          // The process is gone, which already releases the line to its off state.
        }
      },
      isEnabled: () => commanded && relayState.alive(),
    };

    // --- flow meter ----------------------------------------------------------------------
    const meterChild = deps.spawn("gpiomon", [
      "--chip",
      config.chip,
      "--edges",
      "rising",
      "--format",
      "%e",
      String(config.meterLine),
    ]);
    const meterState = track(meterChild, "flow meter");
    let pulses = 0;
    onLines(meterChild.stdout, () => {
      pulses++;
    });
    this.meter = {
      readPulses: () => {
        // A dead monitor would freeze the count while fuel still flows, so refuse to report.
        if (!meterState.alive()) throw new Error("the flow meter monitor is not running");
        return pulses;
      },
    };

    // --- emergency stop ------------------------------------------------------------------
    // Polled with gpioget rather than watched for edges: a line cannot be read while an edge
    // monitor holds it, and an edge stream gives no way to learn the starting level without a
    // gap in which a change could be missed. The hardware E-stop cuts pump power by itself, so
    // the software only needs to notice within a poll interval. Unknown means engaged.
    const engagedLevel = config.estopEngagedLevel ?? "high";
    let estopEngaged = true;
    let estopReadFailing = false;
    const estopChanges = new Emitter<boolean>();
    const setEstop = (engaged: boolean) => {
      if (engaged === estopEngaged) return;
      estopEngaged = engaged;
      estopChanges.emit(engaged);
    };
    let polling = false;
    const pollEstop = async (): Promise<void> => {
      if (polling) return;
      polling = true;
      try {
        const out = await deps.read("gpioget", ["--chip", config.chip, String(config.estopLine)]);
        const level = /=active\s*$/.test(out.trim()) ? "high" : "low";
        estopReadFailing = false;
        setEstop(level === engagedLevel);
      } catch (error) {
        if (!estopReadFailing) {
          fail(error instanceof Error ? error : new Error("could not read the emergency stop"));
        }
        estopReadFailing = true;
        setEstop(true);
      } finally {
        polling = false;
      }
    };
    this.#ready = pollEstop();
    this.#estopTimer = setInterval(() => void pollEstop(), config.estopPollMs ?? 250);
    this.#estopTimer.unref();
    this.estop = {
      isEngaged: () => estopEngaged,
      onChange: (listener) => estopChanges.subscribe(listener),
    };

    // --- buttons -------------------------------------------------------------------------
    const presses = new Emitter<ButtonName>();
    const buttonChild = deps.spawn("gpiomon", [
      "--chip",
      config.chip,
      "--edges",
      "falling",
      "--debounce-period",
      "30ms",
      "--format",
      "%o",
      String(config.startButtonLine),
      String(config.stopButtonLine),
    ]);
    track(buttonChild, "button monitor");
    onLines(buttonChild.stdout, (line) => {
      if (line === String(config.startButtonLine)) presses.emit("start");
      else if (line === String(config.stopButtonLine)) presses.emit("stop");
    });
    this.buttons = { onPress: (listener) => presses.subscribe(listener) };

    this.reader = deps.openReader(config.rfidDevice, fail);
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  close(): void {
    clearInterval(this.#estopTimer);
    this.relay.disable();
    this.reader.close();
    for (const child of this.#children) {
      try {
        if (child === this.#relayChild) {
          // Let gpioset apply the queued off command and exit by itself; killing it first
          // could drop the command. Closing the pipe makes it exit, the kill is a fallback.
          child.stdin?.write("exit\n");
          child.stdin?.end();
          setTimeout(() => child.kill(), 1000).unref();
        } else {
          child.stdin?.end();
          child.kill();
        }
      } catch {
        // Already closed.
      }
    }
  }
}
