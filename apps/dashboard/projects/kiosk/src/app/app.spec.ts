import type { Snapshot } from "@agriflow/core";
import type { SocketLike } from "@agriflow/shared";
import { TestBed } from "@angular/core/testing";
import { App } from "./app";
import { CONTROLLER_URL, controllerUrl, LOCALE, localeFrom, SOCKET_FACTORY } from "./kiosk-store";

const idle: Snapshot = {
  phase: "idle",
  pumpOn: false,
  estopEngaged: false,
  operatorId: null,
  machineId: null,
  liters: 0,
  endReason: null,
  notice: { kind: "none" },
};

class FakeSocket implements SocketLike {
  sent: unknown[] = [];
  onopen: ((event: never) => void) | null = null;
  onclose: ((event: never) => void) | null = null;
  onerror: ((event: never) => void) | null = null;
  onmessage: ((event: never) => void) | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {}
  open(): void {
    this.onopen?.(undefined as never);
  }
  drop(): void {
    this.onclose?.(undefined as never);
  }
  push(snapshot: Snapshot): void {
    this.onmessage?.({ data: JSON.stringify({ type: "state", snapshot }) } as never);
  }
}

async function setup(locale: "es" | "en" = "es") {
  const socket = new FakeSocket();
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      { provide: SOCKET_FACTORY, useValue: () => socket },
      { provide: CONTROLLER_URL, useValue: "ws://test/ws" },
      { provide: LOCALE, useValue: locale },
    ],
  });
  const fixture = TestBed.createComponent(App);
  await fixture.whenStable();
  socket.open();
  const el = fixture.nativeElement as HTMLElement;
  const show = async (snapshot: Snapshot) => {
    socket.push(snapshot);
    await fixture.whenStable();
  };
  const text = () => el.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const button = (label: string) =>
    Array.from(el.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
  const click = async (label: string) => {
    button(label)?.click();
    await fixture.whenStable();
  };
  return { socket, fixture, el, show, text, button, click };
}

describe("kiosk", () => {
  it("shows a neutral screen until the controller reports its state", async () => {
    const { text } = await setup();
    expect(text()).toContain("AgriFlow");
  });

  it("asks for the fob when idle and explains a denied scan", async () => {
    const { show, text } = await setup();
    await show(idle);
    expect(text()).toContain("Acerque su llavero");
    await show({ ...idle, notice: { kind: "denied", reason: "machine_not_permitted" } });
    expect(text()).toContain("No tiene permiso para este equipo");
    await show({ ...idle, notice: { kind: "lapsed" } });
    expect(text()).toContain("La autorización venció");
  });

  it("takes the equipment number on the keypad and sends it", async () => {
    const { socket, show, click, el, button } = await setup();
    await show({ ...idle, phase: "awaiting_machine" });
    expect(button("Aceptar")?.disabled).toBe(true);
    for (const key of ["T", "-", "1", "2"]) await click(key);
    expect(el.querySelector("[data-testid=equipment-display]")?.textContent).toContain("T-12");
    await click("Aceptar");
    expect(socket.sent).toEqual([{ type: "select_machine", equipmentNumber: "T-12" }]);
    expect(el.querySelector("[data-testid=equipment-display]")?.textContent).toContain(
      "Por ejemplo",
    );
  });

  it("erases keys and stops accepting at the longest equipment number", async () => {
    const { show, click, el } = await setup();
    await show({ ...idle, phase: "awaiting_machine" });
    for (let i = 0; i < 20; i++) await click("A");
    const display = () => el.querySelector("[data-testid=equipment-display]")?.textContent?.trim();
    expect(display()).toBe("A".repeat(16));
    await click("Borrar");
    expect(display()).toBe("A".repeat(15));
  });

  it("starts or cancels from the authorized screen", async () => {
    const { socket, show, click, text } = await setup();
    await show({ ...idle, phase: "authorized", operatorId: "op-0007", machineId: "m-t12" });
    expect(text()).toContain("op-0007");
    expect(text()).toContain("m-t12");
    await click("INICIAR");
    await click("Cancelar");
    expect(socket.sent).toEqual([{ type: "start" }, { type: "stop" }]);
  });

  it("shows the liters while dispensing and stops on request", async () => {
    const { socket, show, click, el } = await setup();
    await show({
      ...idle,
      phase: "dispensing",
      pumpOn: true,
      operatorId: "op-0007",
      machineId: "m-t12",
      liters: 84.3,
    });
    expect(el.querySelector("[data-testid=liters]")?.textContent).toContain("84,3 L");
    expect(el.textContent).toContain("Bomba encendida");
    await click("DETENER");
    expect(socket.sent).toEqual([{ type: "stop" }]);
  });

  it("shows the total and why it ended, then dismisses", async () => {
    const { socket, show, click, text } = await setup();
    await show({
      ...idle,
      phase: "finished",
      operatorId: "op-0007",
      machineId: "m-t12",
      liters: 84.3,
      endReason: "max_liters",
    });
    expect(text()).toContain("Carga finalizada");
    expect(text()).toContain("84,3 L");
    expect(text()).toContain("Límite de litros alcanzado");
    await click("Aceptar");
    expect(socket.sent).toEqual([{ type: "dismiss" }]);
  });

  it("makes an engaged emergency stop impossible to miss and blocks starting", async () => {
    const { show, text, button } = await setup();
    await show({
      ...idle,
      phase: "authorized",
      estopEngaged: true,
      operatorId: "op-0007",
      machineId: "m-t12",
    });
    expect(text()).toContain("PARADA DE EMERGENCIA ACTIVA");
    expect(button("INICIAR")?.disabled).toBe(true);
  });

  it("warns and disables the controls when the controller connection is lost", async () => {
    const { socket, fixture, show, text, button } = await setup();
    await show({ ...idle, phase: "dispensing", pumpOn: true, liters: 5 });
    expect(text()).not.toContain("Sin conexión");
    socket.drop();
    await fixture.whenStable();
    expect(text()).toContain("Sin conexión con el controlador");
    expect(text()).toContain("Use el botón físico de parada");
    expect(button("DETENER")?.disabled).toBe(true);
  });

  it("speaks English when asked", async () => {
    const { show, text } = await setup("en");
    await show(idle);
    expect(text()).toContain("Present your fob");
    await show({ ...idle, notice: { kind: "fault", reason: "implausible_flow" } });
    expect(text()).toContain("Abnormal flow detected");
  });

  it("never renders a fob UID, even if a snapshot were to carry one", async () => {
    const { socket, fixture, text } = await setup();
    socket.onmessage?.({
      data: JSON.stringify({ type: "state", snapshot: { ...idle, uid: "04A1B2C3" } }),
    } as never);
    await fixture.whenStable();
    expect(text()).not.toContain("04A1B2C3");
  });
});

describe("controller address", () => {
  const at = (search: string, protocol = "http:") => ({
    protocol,
    host: "kiosk.local:4100",
    search,
  });

  it("defaults to the origin that served the page", () => {
    expect(controllerUrl(at(""))).toBe("ws://kiosk.local:4100/ws");
    expect(controllerUrl(at("", "https:"))).toBe("wss://kiosk.local:4100/ws");
  });

  it("accepts a well-formed websocket override and rejects anything else", () => {
    expect(controllerUrl(at("?controller=ws://127.0.0.1:4100/ws"))).toBe("ws://127.0.0.1:4100/ws");
    for (const bad of [
      "http://evil.example/ws",
      "ws://evil.example/other",
      "javascript:alert(1)",
      "ws://a b/ws",
      "ws://localhost:99999/ws",
      "ws://user:pw@localhost:4100/ws",
      "ws://localhost:4100/ws?x=1",
    ]) {
      expect(controllerUrl(at(`?controller=${encodeURIComponent(bad)}`))).toBe(
        "ws://kiosk.local:4100/ws",
      );
    }
  });

  it("chooses the language from the query", () => {
    expect(localeFrom("")).toBe("es");
    expect(localeFrom("?lang=en")).toBe("en");
    expect(localeFrom("?lang=fr")).toBe("es");
  });
});
