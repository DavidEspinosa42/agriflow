import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { evdevEventSize, WedgeReader } from "./wedge-reader.ts";

const SIZE = 24;
const EV_KEY = 1;
const EV_SYN = 0;
const KEY = { "0": 11, "1": 2, "4": 5, A: 30, B: 48, C: 46, ENTER: 28 } as const;

function event(type: number, code: number, value: number, size = SIZE): Buffer {
  const buffer = Buffer.alloc(size);
  buffer.writeUInt16LE(type, size - 8);
  buffer.writeUInt16LE(code, size - 6);
  buffer.writeInt32LE(value, size - 4);
  return buffer;
}

/** A key press and release, as the kernel delivers them, with a sync event after each. */
const tap = (code: number, size = SIZE) =>
  Buffer.concat([
    event(EV_KEY, code, 1, size),
    event(EV_SYN, 0, 0, size),
    event(EV_KEY, code, 0, size),
    event(EV_SYN, 0, 0, size),
  ]);

function setup(options: { size?: number; idle?: number } = {}) {
  const stream = new PassThrough();
  let now = 1000;
  const reader = new WedgeReader(stream, {
    eventSize: options.size ?? SIZE,
    idleResetMs: options.idle ?? 1000,
    now: () => now,
  });
  const uids: string[] = [];
  reader.onScan((uid) => uids.push(uid));
  return { stream, uids, advance: (ms: number) => (now += ms) };
}

describe("WedgeReader", () => {
  it("assembles a UID from key presses and emits it on Enter", () => {
    const { stream, uids } = setup();
    for (const code of [KEY["0"], KEY["4"], KEY.A, KEY["1"], KEY.B, KEY.C, KEY.ENTER]) {
      stream.write(tap(code));
    }
    expect(uids).toEqual(["04A1BC"]);
  });

  it("ignores key releases and non-key events", () => {
    const { stream, uids } = setup();
    stream.write(Buffer.concat([event(EV_KEY, KEY.A, 0), event(EV_SYN, 0, 0), event(4, 4, 99)]));
    stream.write(tap(KEY.ENTER));
    expect(uids).toEqual([]);
  });

  it("handles events split across chunks", () => {
    const { stream, uids } = setup();
    const data = Buffer.concat([tap(KEY.A), tap(KEY.ENTER)]);
    for (let i = 0; i < data.length; i += 7) stream.write(data.subarray(i, i + 7));
    expect(uids).toEqual(["A"]);
  });

  it("supports 16-byte events on 32-bit systems", () => {
    expect(evdevEventSize("arm")).toBe(16);
    expect(evdevEventSize("arm64")).toBe(24);
    const { stream, uids } = setup({ size: 16 });
    stream.write(Buffer.concat([tap(KEY.A, 16), tap(KEY.ENTER, 16)]));
    expect(uids).toEqual(["A"]);
  });

  it("emits nothing for a bare Enter and starts fresh after each scan", () => {
    const { stream, uids } = setup();
    stream.write(tap(KEY.ENTER));
    stream.write(Buffer.concat([tap(KEY.A), tap(KEY.ENTER), tap(KEY.B), tap(KEY.ENTER)]));
    expect(uids).toEqual(["A", "B"]);
  });

  it("drops a half-typed UID after a pause so two scans never join", () => {
    const { stream, uids, advance } = setup({ idle: 500 });
    stream.write(tap(KEY.A));
    advance(2000);
    stream.write(Buffer.concat([tap(KEY.B), tap(KEY.ENTER)]));
    expect(uids).toEqual(["B"]);
  });

  it("discards an over-long line entirely instead of emitting a fragment", () => {
    const stream = new PassThrough();
    const reader = new WedgeReader(stream, { eventSize: SIZE, maxLength: 4, now: () => 1000 });
    const uids: string[] = [];
    reader.onScan((uid) => uids.push(uid));
    for (let i = 0; i < 10; i++) stream.write(tap(KEY.A));
    stream.write(tap(KEY.ENTER));
    stream.write(Buffer.concat([tap(KEY.B), tap(KEY.ENTER)]));
    expect(uids).toEqual(["B"]);
  });

  it("stops delivering after unsubscribe and reports device errors", () => {
    const stream = new PassThrough();
    const errors: Error[] = [];
    const reader = new WedgeReader(stream, { eventSize: SIZE, onError: (e) => errors.push(e) });
    const uids: string[] = [];
    const off = reader.onScan((uid) => uids.push(uid));
    off();
    stream.write(Buffer.concat([tap(KEY.A), tap(KEY.ENTER)]));
    expect(uids).toEqual([]);
    stream.emit("error", new Error("device unplugged"));
    expect(errors.map((e) => e.message)).toEqual(["device unplugged"]);
  });

  it("releases the device on close so the process can exit", () => {
    const stream = new PassThrough();
    const reader = new WedgeReader(stream, { eventSize: SIZE });
    const uids: string[] = [];
    reader.onScan((uid) => uids.push(uid));
    reader.close();
    expect(stream.destroyed).toBe(true);
  });
});
