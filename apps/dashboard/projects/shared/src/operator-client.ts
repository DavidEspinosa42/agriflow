import { ClientCommand, ServerMessage, type Snapshot } from "@agriflow/core";

/**
 * The few WebSocket members the client uses, so tests can supply a fake. Handler parameters are
 * `never` so a browser `WebSocket`, whose handlers receive an event, is assignable without casts.
 */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: never) => void) | null;
  onclose: ((event: never) => void) | null;
  onerror: ((event: never) => void) | null;
  onmessage: ((event: never) => void) | null;
}

/** What the client reads from a message event. */
interface MessageLike {
  readonly data: unknown;
}

export type ConnectionState = "connecting" | "open" | "closed";

export interface OperatorClientOptions {
  /** For example ws://127.0.0.1:4100/ws */
  readonly url: string;
  readonly createSocket: (url: string) => SocketLike;
  readonly onSnapshot: (snapshot: Snapshot) => void;
  readonly onConnection: (state: ConnectionState) => void;
  /** First reconnect delay; doubles up to `maxRetryMs`. */
  readonly retryMs?: number;
  readonly maxRetryMs?: number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/**
 * Keeps a WebSocket to the controller open and hands validated snapshots to the screen. It
 * reconnects with a capped backoff. Anything that does not match the shared protocol is dropped.
 */
export class OperatorClient {
  readonly #o: OperatorClientOptions;
  #socket: SocketLike | null = null;
  #timer: unknown = null;
  #delay: number;
  #running = false;

  constructor(options: OperatorClientOptions) {
    this.#o = options;
    this.#delay = options.retryMs ?? 1000;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#connect();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) (this.#o.clearTimer ?? clearTimeout)(this.#timer as never);
    this.#timer = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      socket.onclose = null;
      socket.close();
    }
    this.#o.onConnection("closed");
  }

  /** Send a command. Returns false, and sends nothing, unless the connection is open. */
  send(command: ClientCommand): boolean {
    const parsed = ClientCommand.safeParse(command);
    const socket = this.#socket;
    if (!parsed.success || socket === null || this.#state !== "open") return false;
    socket.send(JSON.stringify(parsed.data));
    return true;
  }

  #state: ConnectionState = "closed";

  #setState(state: ConnectionState): void {
    this.#state = state;
    this.#o.onConnection(state);
  }

  #connect(): void {
    this.#setState("connecting");
    const socket = this.#o.createSocket(this.#o.url);
    this.#socket = socket;
    socket.onopen = () => {
      this.#delay = this.#o.retryMs ?? 1000;
      this.#setState("open");
    };
    socket.onmessage = (event: MessageLike) => {
      if (typeof event.data !== "string") return;
      let json: unknown;
      try {
        json = JSON.parse(event.data);
      } catch {
        return;
      }
      const message = ServerMessage.safeParse(json);
      if (message.success && message.data.type === "state") {
        this.#o.onSnapshot(message.data.snapshot);
      }
    };
    socket.onerror = () => undefined;
    socket.onclose = () => {
      this.#socket = null;
      this.#setState("closed");
      if (!this.#running) return;
      const wait = this.#delay;
      this.#delay = Math.min(this.#delay * 2, this.#o.maxRetryMs ?? 5000);
      this.#timer = (this.#o.setTimer ?? setTimeout)(() => {
        this.#timer = null;
        if (this.#running) this.#connect();
      }, wait);
    };
  }
}
