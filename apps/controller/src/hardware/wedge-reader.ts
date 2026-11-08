import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import type { RfidReader, Unsubscribe } from "./interfaces.ts";

/** Linux evdev key codes (linux/input-event-codes.h) for the characters a fob UID can contain. */
const KEY_ENTER = 28;
const KEY_KPENTER = 96;
const KEYS: Readonly<Record<number, string>> = {
  2: "1",
  3: "2",
  4: "3",
  5: "4",
  6: "5",
  7: "6",
  8: "7",
  9: "8",
  10: "9",
  11: "0",
  16: "Q",
  17: "W",
  18: "E",
  19: "R",
  20: "T",
  21: "Y",
  22: "U",
  23: "I",
  24: "O",
  25: "P",
  30: "A",
  31: "S",
  32: "D",
  33: "F",
  34: "G",
  35: "H",
  36: "J",
  37: "K",
  38: "L",
  44: "Z",
  45: "X",
  46: "C",
  47: "V",
  48: "B",
  49: "N",
  50: "M",
  71: "7",
  72: "8",
  73: "9",
  75: "4",
  76: "5",
  77: "6",
  79: "1",
  80: "2",
  81: "3",
  82: "0",
};

const EV_KEY = 1;
const KEY_PRESS = 1;

/** `struct input_event` is 24 bytes on 64-bit Linux and 16 bytes on 32-bit ARM. */
export function evdevEventSize(arch: string = process.arch): number {
  return arch === "arm" || arch === "ia32" ? 16 : 24;
}

export interface WedgeReaderOptions {
  readonly eventSize?: number;
  /** A partly typed UID is dropped after this long without a key, so noise cannot join two scans. */
  readonly idleResetMs?: number;
  readonly maxLength?: number;
  readonly now?: () => number;
  /** Called if the device disappears or cannot be read. */
  readonly onError?: (error: Error) => void;
}

/**
 * Turns raw evdev key events from a keyboard-wedge RFID reader into UIDs: the reader types the
 * UID followed by Enter. Anything that is not a plausible UID is discarded.
 */
export class WedgeReader implements RfidReader {
  readonly #listeners = new Set<(uid: string) => void>();
  readonly #eventSize: number;
  readonly #idleResetMs: number;
  readonly #maxLength: number;
  readonly #now: () => number;
  readonly #input: Readable;
  #pending = Buffer.alloc(0);
  #typed = "";
  #overflow = false;
  #lastKeyAtMs = 0;

  constructor(input: Readable, options: WedgeReaderOptions = {}) {
    this.#eventSize = options.eventSize ?? evdevEventSize();
    this.#idleResetMs = options.idleResetMs ?? 1000;
    this.#maxLength = options.maxLength ?? 32;
    this.#now = options.now ?? Date.now;
    this.#input = input;
    input.on("data", (chunk: Buffer) => this.#feed(chunk));
    input.on("error", (error: Error) => options.onError?.(error));
  }

  /** Stop reading and release the device so the process can exit. */
  close(): void {
    this.#listeners.clear();
    this.#input.destroy();
  }

  onScan(listener: (uid: string) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #feed(chunk: Buffer): void {
    this.#pending = Buffer.concat([this.#pending, chunk]);
    const size = this.#eventSize;
    while (this.#pending.length >= size) {
      const event = this.#pending.subarray(0, size);
      this.#pending = this.#pending.subarray(size);
      const type = event.readUInt16LE(size - 8);
      const code = event.readUInt16LE(size - 6);
      const value = event.readInt32LE(size - 4);
      if (type === EV_KEY && value === KEY_PRESS) this.#key(code);
    }
  }

  #key(code: number): void {
    const nowMs = this.#now();
    if (nowMs - this.#lastKeyAtMs > this.#idleResetMs) this.#reset();
    this.#lastKeyAtMs = nowMs;
    if (code === KEY_ENTER || code === KEY_KPENTER) {
      const uid = this.#overflow ? "" : this.#typed;
      this.#reset();
      if (uid.length > 0) for (const listener of [...this.#listeners]) listener(uid);
      return;
    }
    const char = KEYS[code];
    if (char === undefined || this.#overflow) return;
    // Longer than any fob UID: it is not a scan, so ignore everything up to the next Enter.
    if (this.#typed.length >= this.#maxLength) this.#overflow = true;
    else this.#typed += char;
  }

  #reset(): void {
    this.#typed = "";
    this.#overflow = false;
  }
}

/** Open an input device node such as /dev/input/by-id/usb-...-event-kbd for reading. */
export function openWedgeDevice(path: string, options: WedgeReaderOptions = {}): WedgeReader {
  return new WedgeReader(createReadStream(path), options);
}
