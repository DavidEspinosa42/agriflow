import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertGpioTools, type ChildLike, type GpioConfig, GpioHardware } from "./gpio.ts";

class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new EventEmitter() as ChildLike["stdout"] & EventEmitter;
  readonly written: string[] = [];
  ended = false;
  killed = false;
  readonly stdin = Object.assign(new EventEmitter(), {
    write: (text: string) => {
      this.written.push(text);
      return true;
    },
    end: () => {
      this.ended = true;
    },
  }) as unknown as ChildLike["stdin"];
  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as never);
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  print(text: string): void {
    this.stdout.emit("data", Buffer.from(text));
  }
  die(): void {
    this.emit("exit");
  }
}

const config: GpioConfig = {
  chip: "gpiochip0",
  relayLine: 17,
  meterLine: 27,
  estopLine: 22,
  startButtonLine: 23,
  stopButtonLine: 24,
  estopPollMs: 100,
  rfidDevice: "/dev/input/event0",
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

interface Options {
  /** What gpioget reports for the E-stop line; "fail" makes the read throw. */
  estop?: "active" | "inactive" | "fail";
  config?: GpioConfig;
}

function setup(options: Options = {}) {
  const calls: { command: string; args: string[]; child: FakeChild }[] = [];
  const errors: Error[] = [];
  const scans: ((uid: string) => void)[] = [];
  const readerClosed = { value: false };
  const estopLevel = { value: options.estop ?? "inactive" };
  const hardware = new GpioHardware(options.config ?? config, {
    spawn: (command, args) => {
      const child = new FakeChild();
      calls.push({ command, args, child });
      return child;
    },
    run: () => "",
    read: async () => {
      if (estopLevel.value === "fail") throw new Error("gpioget failed");
      return `"22"=${estopLevel.value}\n`;
    },
    openReader: () => ({
      onScan: (listener) => {
        scans.push(listener);
        return () => undefined;
      },
      close: () => {
        readerClosed.value = true;
      },
    }),
    onError: (e) => errors.push(e),
  });
  const child = (n: number) => calls[n]?.child as FakeChild;
  // Spawn order: relay, meter, buttons.
  return {
    hardware,
    calls,
    errors,
    scans,
    readerClosed,
    estopLevel,
    relay: child(0),
    meter: child(1),
    buttons: child(2),
  };
}

/** Let one poll interval pass and the asynchronous read settle. */
const poll = () => vi.advanceTimersByTimeAsync(100);

describe("GpioHardware", () => {
  it("starts the relay off through an interactive gpioset", () => {
    const s = setup();
    expect(s.calls[0]?.command).toBe("gpioset");
    expect(s.calls[0]?.args).toEqual(["--interactive", "--chip", "gpiochip0", "17=inactive"]);
    expect(s.hardware.relay.isEnabled()).toBe(false);
  });

  it("switches the relay with commands and reports the commanded state", () => {
    const s = setup();
    s.hardware.relay.enable();
    expect(s.hardware.relay.isEnabled()).toBe(true);
    s.hardware.relay.disable();
    expect(s.hardware.relay.isEnabled()).toBe(false);
    expect(s.relay.written).toEqual(["set 17=1\n", "set 17=0\n"]);
  });

  it("cannot enable the relay after its process died, and reports off", () => {
    const s = setup();
    s.hardware.relay.enable();
    s.relay.die();
    expect(s.hardware.relay.isEnabled()).toBe(false);
    expect(() => s.hardware.relay.enable()).toThrow(/not running/);
    expect(() => s.hardware.relay.disable()).not.toThrow();
    expect(s.errors.map((e) => e.message)).toEqual(["relay process stopped"]);
  });

  it("drains the relay process output so its pipe can never fill and block commands", () => {
    const s = setup();
    expect(s.relay.stdout.listenerCount("data")).toBeGreaterThan(0);
  });

  it("refuses to enable the relay after any monitor has died, such as the buttons", () => {
    const s = setup();
    s.buttons.die();
    expect(() => s.hardware.relay.enable()).toThrow(/monitor has stopped/);
    expect(s.hardware.relay.isEnabled()).toBe(false);
    expect(s.relay.written).toEqual([]);
  });

  it("counts flow meter pulses, including lines split across chunks", () => {
    const s = setup();
    s.meter.print("1\n1\n1");
    s.meter.print("\n1\n");
    expect(s.hardware.meter.readPulses()).toBe(4);
  });

  it("refuses to report pulses once the meter monitor has stopped", () => {
    const s = setup();
    s.meter.print("1\n");
    s.meter.die();
    expect(() => s.hardware.meter.readPulses()).toThrow(/not running/);
  });

  it("treats the emergency stop as engaged until its state is verified", async () => {
    const s = setup({ estop: "inactive" });
    expect(s.hardware.estop.isEngaged()).toBe(true);
    await s.hardware.ready?.();
    expect(s.hardware.estop.isEngaged()).toBe(false);
  });

  it("follows emergency stop changes by polling and reports each change once", async () => {
    const s = setup({ estop: "inactive" }); // low: loop closed, not engaged
    await s.hardware.ready?.();
    const seen: boolean[] = [];
    s.hardware.estop.onChange((engaged) => seen.push(engaged));
    s.estopLevel.value = "active"; // high: loop opened
    await poll();
    expect(s.hardware.estop.isEngaged()).toBe(true);
    await poll(); // unchanged
    s.estopLevel.value = "inactive";
    await poll();
    expect(s.hardware.estop.isEngaged()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("treats an unreadable emergency stop as engaged and reports the failure once", async () => {
    const s = setup({ estop: "fail" });
    await s.hardware.ready?.();
    expect(s.hardware.estop.isEngaged()).toBe(true);
    await poll();
    await poll();
    expect(s.errors.map((e) => e.message)).toEqual(["gpioget failed"]);
    s.estopLevel.value = "inactive";
    await poll();
    expect(s.hardware.estop.isEngaged()).toBe(false);
  });

  it("honours an emergency stop that engages on a low level", async () => {
    const s = setup({ estop: "inactive", config: { ...config, estopEngagedLevel: "low" } });
    await s.hardware.ready?.();
    expect(s.hardware.estop.isEngaged()).toBe(true);
    s.estopLevel.value = "active";
    await poll();
    expect(s.hardware.estop.isEngaged()).toBe(false);
  });

  it("maps button lines to start and stop presses", () => {
    const s = setup();
    const pressed: string[] = [];
    s.hardware.buttons.onPress((b) => pressed.push(b));
    s.buttons.print("23\n24\n99\n23\n");
    expect(pressed).toEqual(["start", "stop", "start"]);
  });

  it("passes fob scans through from the reader", () => {
    const s = setup();
    const uids: string[] = [];
    s.hardware.reader.onScan((uid) => uids.push(uid));
    s.scans[0]?.("04A1B2C3");
    expect(uids).toEqual(["04A1B2C3"]);
  });

  it("turns the relay off, lets gpioset exit cleanly, and stops everything on close", async () => {
    const s = setup();
    s.hardware.relay.enable();
    s.hardware.close();
    // The off command is queued before the pipe closes, so gpioset applies it and exits.
    expect(s.relay.written.slice(-2)).toEqual(["set 17=0\n", "exit\n"]);
    expect(s.relay.ended).toBe(true);
    expect(s.relay.killed).toBe(false);
    expect(s.meter.killed).toBe(true);
    expect(s.buttons.killed).toBe(true);
    expect(s.readerClosed.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.relay.killed).toBe(true);
  });

  it("stops polling the emergency stop after close", async () => {
    const s = setup();
    await s.hardware.ready?.();
    s.hardware.close();
    s.estopLevel.value = "active";
    await poll();
    expect(s.hardware.estop.isEngaged()).toBe(false);
  });
});

describe("assertGpioTools", () => {
  it("requires gpioset with interactive support", () => {
    expect(() => assertGpioTools(() => "Usage: gpioset --interactive ...")).not.toThrow();
    expect(() => assertGpioTools(() => "Usage: gpioset [OPTIONS]")).toThrow(/--interactive/);
    expect(() =>
      assertGpioTools(() => {
        throw new Error("ENOENT");
      }),
    ).toThrow(/not found/);
  });
});
