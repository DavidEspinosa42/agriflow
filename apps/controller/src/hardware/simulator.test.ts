import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createHardware, gpioConfigFromEnv, parseDriver } from "./factory.ts";
import { SimulatedHardware } from "./simulator.ts";

describe("SimulatedHardware", () => {
  it("rejects invalid calibration or flow options", () => {
    for (const bad of [-100, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new SimulatedHardware({ pulsesPerLiter: bad })).toThrow(RangeError);
      expect(() => new SimulatedHardware({ flowLitersPerMinute: bad })).toThrow(RangeError);
    }
  });

  it("starts with the relay off and no flow", () => {
    const hw = new SimulatedHardware();
    expect(hw.relay.isEnabled()).toBe(false);
    expect(hw.pumpPowered()).toBe(false);
    expect(hw.meter.readPulses()).toBe(0);
    expect(hw.estop.isEngaged()).toBe(false);
  });

  it("counts pulses only while the pump is powered", () => {
    const hw = new SimulatedHardware({ pulsesPerLiter: 100, flowLitersPerMinute: 60 });
    hw.advance(5000);
    expect(hw.meter.readPulses()).toBe(0);
    hw.relay.enable();
    hw.advance(1000); // 1 L at 60 L/min
    expect(hw.meter.readPulses()).toBe(100);
    hw.relay.disable();
    hw.advance(10_000);
    expect(hw.meter.readPulses()).toBe(100);
  });

  it("keeps the counter monotonic and carries fractional pulses", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(2000), { maxLength: 40 }), (steps) => {
        const hw = new SimulatedHardware({ pulsesPerLiter: 7, flowLitersPerMinute: 13 });
        hw.relay.enable();
        let last = 0;
        let totalMs = 0;
        for (const ms of steps) {
          hw.advance(ms);
          totalMs += ms;
          const pulses = hw.meter.readPulses();
          expect(pulses).toBeGreaterThanOrEqual(last);
          last = pulses;
        }
        expect(Math.abs(last - (13 / 60) * (totalMs / 1000) * 7)).toBeLessThan(1);
      }),
    );
  });

  it("cuts pump power on E-stop regardless of the relay command", () => {
    const hw = new SimulatedHardware();
    const seen: boolean[] = [];
    hw.estop.onChange((engaged) => seen.push(engaged));
    hw.relay.enable();
    expect(hw.pumpPowered()).toBe(true);
    hw.engageEstop();
    expect(hw.pumpPowered()).toBe(false);
    hw.advance(5000);
    expect(hw.meter.readPulses()).toBe(0);
    hw.releaseEstop();
    expect(seen).toEqual([true, false]);
  });

  it("delivers scans and presses to subscribers until they unsubscribe", () => {
    const hw = new SimulatedHardware();
    const uids: string[] = [];
    const buttons: string[] = [];
    const offScan = hw.reader.onScan((uid) => uids.push(uid));
    hw.buttons.onPress((b) => buttons.push(b));
    hw.scan("04A1B2C3");
    hw.press("stop");
    offScan();
    hw.scan("ignored");
    expect(uids).toEqual(["04A1B2C3"]);
    expect(buttons).toEqual(["stop"]);
  });

  it("turns the pump off and ignores enable after close", () => {
    const hw = new SimulatedHardware();
    hw.relay.enable();
    hw.close();
    expect(hw.relay.isEnabled()).toBe(false);
    hw.relay.enable();
    expect(hw.relay.isEnabled()).toBe(false);
  });
});

describe("hardware factory", () => {
  it("creates the simulator and rejects unknown drivers", () => {
    expect(createHardware("simulator")).toBeInstanceOf(SimulatedHardware);
    expect(() => createHardware("gpio")).toThrow(/GPIO_\* settings/);
    expect(parseDriver(undefined)).toBe("simulator");
    expect(parseDriver("gpio")).toBe("gpio");
    expect(() => parseDriver("usb")).toThrow(/HARDWARE_DRIVER/);
  });

  it("reads the GPIO wiring from the environment and rejects incomplete settings", () => {
    const env = {
      GPIO_RELAY: "17",
      GPIO_METER: "27",
      GPIO_ESTOP: "22",
      GPIO_BUTTON_START: "23",
      GPIO_BUTTON_STOP: "24",
      RFID_DEVICE: "/dev/input/by-id/reader-event-kbd",
    };
    expect(gpioConfigFromEnv(env)).toMatchObject({
      chip: "gpiochip0",
      relayLine: 17,
      meterLine: 27,
      estopEngagedLevel: "high",
    });
    expect(() => gpioConfigFromEnv({ ...env, GPIO_RELAY: undefined })).toThrow(/GPIO_RELAY/);
    expect(() => gpioConfigFromEnv({ ...env, GPIO_METER: "abc" })).toThrow(/GPIO_METER/);
    for (const blank of ["", "  ", "-1", "1.5", "1e1"]) {
      expect(() => gpioConfigFromEnv({ ...env, GPIO_RELAY: blank })).toThrow(/GPIO_RELAY/);
    }
    expect(() => gpioConfigFromEnv({ ...env, RFID_DEVICE: undefined })).toThrow(/RFID_DEVICE/);
    expect(() => gpioConfigFromEnv({ ...env, GPIO_ESTOP_ENGAGED_LEVEL: "up" })).toThrow(/ENGAGED/);
  });
});
