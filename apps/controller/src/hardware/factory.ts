import { assertGpioTools, type GpioConfig, GpioHardware, gpioDefaults } from "./gpio.ts";
import type { Hardware, HardwareDriver } from "./interfaces.ts";
import { SimulatedHardware, type SimulatorOptions } from "./simulator.ts";

export interface HardwareOptions {
  readonly simulator?: SimulatorOptions;
  readonly gpio?: GpioConfig;
  readonly onError?: (error: Error) => void;
}

/** Create the hardware for the configured driver. Unknown drivers fail instead of falling back. */
export function createHardware(driver: HardwareDriver, options: HardwareOptions = {}): Hardware {
  switch (driver) {
    case "simulator":
      return new SimulatedHardware(options.simulator);
    case "gpio": {
      if (options.gpio === undefined)
        throw new Error("HARDWARE_DRIVER=gpio needs the GPIO_* settings");
      assertGpioTools();
      return new GpioHardware(options.gpio, {
        ...gpioDefaults,
        ...(options.onError === undefined ? {} : { onError: options.onError }),
      });
    }
    default: {
      const unknown: never = driver;
      throw new Error(`unknown hardware driver: ${String(unknown)}`);
    }
  }
}

export function parseDriver(value: string | undefined): HardwareDriver {
  if (value === undefined || value === "simulator") return "simulator";
  if (value === "gpio") return "gpio";
  throw new Error(`HARDWARE_DRIVER must be "simulator" or "gpio", got "${value}"`);
}

/** Read the GPIO wiring from environment variables. All values are required: no guessed pins. */
export function gpioConfigFromEnv(env: Record<string, string | undefined>): GpioConfig {
  const line = (name: string): number => {
    const raw = env[name]?.trim() ?? "";
    // Number("") is 0, which would silently select line 0 for a blank setting.
    const value = /^[0-9]{1,3}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(value) || value < 0 || value > 999) {
      throw new Error(`${name} must be a GPIO line number`);
    }
    return value;
  };
  const rfidDevice = env["RFID_DEVICE"];
  if (rfidDevice === undefined || rfidDevice === "") throw new Error("RFID_DEVICE is not set");
  const level = env["GPIO_ESTOP_ENGAGED_LEVEL"] ?? "high";
  if (level !== "high" && level !== "low") {
    throw new Error("GPIO_ESTOP_ENGAGED_LEVEL must be high or low");
  }
  return {
    chip: env["GPIO_CHIP"] ?? "gpiochip0",
    relayLine: line("GPIO_RELAY"),
    meterLine: line("GPIO_METER"),
    estopLine: line("GPIO_ESTOP"),
    startButtonLine: line("GPIO_BUTTON_START"),
    stopButtonLine: line("GPIO_BUTTON_STOP"),
    estopEngagedLevel: level,
    rfidDevice,
  };
}
