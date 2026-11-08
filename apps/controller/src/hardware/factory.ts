import type { Hardware, HardwareDriver } from "./interfaces.ts";
import { SimulatedHardware, type SimulatorOptions } from "./simulator.ts";

/** Create the hardware for the configured driver. Unknown drivers fail instead of falling back. */
export function createHardware(driver: HardwareDriver, options: SimulatorOptions = {}): Hardware {
  switch (driver) {
    case "simulator":
      return new SimulatedHardware(options);
    case "gpio":
      throw new Error("the gpio driver is not available yet; use HARDWARE_DRIVER=simulator");
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
