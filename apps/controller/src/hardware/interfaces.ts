/** Unsubscribe function returned by every listener registration. */
export type Unsubscribe = () => void;

/** The pump relay. A fresh relay is always off. */
export interface PumpRelay {
  /** Command the pump on. Has no effect on pump power while the E-stop is engaged. */
  enable(): void;
  /** Command the pump off. Always safe to call. */
  disable(): void;
  /** The last commanded state. */
  isEnabled(): boolean;
}

/** A pulse flow meter exposing a monotonically increasing counter. */
export interface FlowMeter {
  readPulses(): number;
}

/** An RFID reader that reports the UID of each presented fob. */
export interface RfidReader {
  onScan(listener: (uid: string) => void): Unsubscribe;
}

/** The physical emergency stop. Software only observes it; the stop cuts pump power in hardware. */
export interface EstopInput {
  isEngaged(): boolean;
  onChange(listener: (engaged: boolean) => void): Unsubscribe;
}

export type ButtonName = "start" | "stop";

/** Physical control buttons next to the touchscreen. */
export interface Buttons {
  onPress(listener: (button: ButtonName) => void): Unsubscribe;
}

export interface Hardware {
  readonly relay: PumpRelay;
  readonly meter: FlowMeter;
  readonly reader: RfidReader;
  readonly estop: EstopInput;
  readonly buttons: Buttons;
  /** Resolves once every input reports a verified state. Start accepting input after this. */
  ready?(): Promise<void>;
  /** Release pins and devices. The relay is commanded off first. */
  close(): void;
}

export type HardwareDriver = "simulator" | "gpio";
