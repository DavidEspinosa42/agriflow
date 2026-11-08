import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

export function controllerDbPath(): string {
  const path = resolve(process.env["CONTROLLER_DB_PATH"] ?? "./data/controller.db");
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

/** Run a CLI task, print a one-line error (never a stack with secrets) and set the exit code. */
export async function runCli(task: () => Promise<void> | void): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

type RawCapable = Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };

/**
 * Read one line without echoing it, for secrets such as fob UIDs. On a terminal the input is read
 * in raw mode so nothing is printed; when piped there is nothing to echo.
 */
export function readHiddenLine(input: RawCapable, prompt: (text: string) => void): Promise<string> {
  prompt("Present the fob and press Enter (input is hidden): ");
  if (input.isTTY !== true || input.setRawMode === undefined) {
    return new Promise((resolveLine, reject) => {
      const rl = createInterface({ input, terminal: false });
      rl.once("line", (line) => {
        // Resolve first: closing the interface fires the close handler, which rejects.
        resolveLine(line);
        rl.close();
      });
      rl.once("close", () => reject(new Error("no input was provided")));
    });
  }
  return new Promise((resolveLine, reject) => {
    let line = "";
    const finish = (action: () => void) => {
      input.setRawMode?.(false);
      input.off("data", onData);
      input.pause();
      prompt("\n");
      action();
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return finish(() => resolveLine(line));
        if (char === "\u0003") return finish(() => reject(new Error("cancelled")));
        if (char === "\u007f" || char === "\b") line = line.slice(0, -1);
        else line += char;
      }
    };
    input.setRawMode?.(true);
    input.resume();
    input.on("data", onData);
  });
}
