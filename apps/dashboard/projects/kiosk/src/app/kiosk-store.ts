import type { ClientCommand, Snapshot } from "@agriflow/core";
import {
  browserStorage,
  type ConnectionState,
  initialLocale,
  type Locale,
  OperatorClient,
  type SocketLike,
} from "@agriflow/shared";
import { DestroyRef, Injectable, InjectionToken, inject, signal } from "@angular/core";

export type SocketFactory = (url: string) => SocketLike;

/**
 * Where the controller's WebSocket is. By default the page's own origin, because the controller
 * serves this app. `?controller=ws://127.0.0.1:4100/ws` points a dev server at a controller.
 */
export function controllerUrl(location: Pick<Location, "protocol" | "host" | "search">): string {
  const override = new URLSearchParams(location.search).get("controller");
  if (override !== null) {
    try {
      // The URL parser also rejects impossible ports and malformed hosts.
      const url = new URL(override);
      const ok =
        (url.protocol === "ws:" || url.protocol === "wss:") &&
        url.pathname === "/ws" &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === "";
      if (ok) return url.href;
    } catch {
      // Fall through to the page's own origin.
    }
  }
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

export function localeFrom(search: string): Locale {
  return initialLocale(search, browserStorage());
}

export const CONTROLLER_URL = new InjectionToken<string>("controllerUrl", {
  factory: () => controllerUrl(location),
});

export const SOCKET_FACTORY = new InjectionToken<SocketFactory>("socketFactory", {
  factory: () => (url) => new WebSocket(url),
});

export const LOCALE = new InjectionToken<Locale>("locale", {
  factory: () => localeFrom(location.search),
});

/** Live controller state for the screen. The controller is the only source of truth. */
@Injectable({ providedIn: "root" })
export class KioskStore {
  readonly snapshot = signal<Snapshot | null>(null);
  readonly connection = signal<ConnectionState>("connecting");
  readonly #client: OperatorClient;

  constructor() {
    this.#client = new OperatorClient({
      url: inject(CONTROLLER_URL),
      createSocket: inject(SOCKET_FACTORY),
      onSnapshot: (snapshot) => this.snapshot.set(snapshot),
      // While disconnected the screen shows an offline banner over the last known state.
      onConnection: (state) => this.connection.set(state),
    });
    this.#client.start();
    inject(DestroyRef).onDestroy(() => this.#client.stop());
  }

  send(command: ClientCommand): boolean {
    return this.#client.send(command);
  }
}
