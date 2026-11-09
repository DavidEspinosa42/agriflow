import { ManagerApi } from "@agriflow/shared";
import { TestBed } from "@angular/core/testing";
import { App } from "./app";
import { niceMax } from "./bar-chart";
import { API_FACTORY, LOCALE, ManagerStore, NOW } from "./manager-store";

// 2026-03-10 15:00 UTC is 12:00 in Argentina.
const NOW_MS = Date.UTC(2026, 2, 10, 15, 0);
const T = (day: number, hour: number) => Date.UTC(2026, 2, day, hour, 0);

const tx = (n: number, machine: string, operator: string, liters: number, startedAtMs: number) => ({
  sessionId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  deviceId: "pump-01",
  tankId: "tank-1",
  operatorId: operator,
  machineId: machine,
  startedAtMs,
  endedAtMs: startedAtMs + 60_000,
  liters,
  endReason: "operator_stop",
  receivedAtMs: NOW_MS - 30 * 60_000,
});

const ALL = [
  tx(1, "T-12", "op-0007", 84.3, T(9, 12)),
  tx(2, "H-03", "op-0012", 120, T(8, 12)),
  tx(3, "T-12", "op-0012", 15.7, T(8, 14)),
];

interface Recorded {
  urls: string[];
}

function backend(options: { validToken?: string; down?: boolean } = {}) {
  const recorded: Recorded = { urls: [] };
  const fetch = async (url: string, init: { headers: Record<string, string> }) => {
    recorded.urls.push(url);
    if (options.down) throw new TypeError("offline");
    if (
      init.headers["authorization"] !== `Bearer ${options.validToken ?? "good-token-0123456789"}`
    ) {
      return { ok: false, status: 401, json: async () => ({}) };
    }
    const u = new URL(url, "http://x");
    const q = u.searchParams;
    let rows = ALL.filter(
      (r) =>
        (q.get("machineId") === null || r.machineId === q.get("machineId")) &&
        (q.get("operatorId") === null || r.operatorId === q.get("operatorId")),
    );
    const body = (() => {
      switch (u.pathname) {
        case "/v1/transactions": {
          const limit = Number(q.get("limit") ?? 50);
          const offset = Number(q.get("offset") ?? 0);
          return { items: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
        }
        case "/v1/reports/consumption":
          return {
            groupBy: "day",
            rows: [
              { key: "2026-03-08", liters: 135.7, sessions: 2 },
              { key: "2026-03-09", liters: 84.3, sessions: 1 },
            ],
          };
        case "/v1/machines":
          return {
            items: [
              { key: "H-03", liters: 120, sessions: 1 },
              { key: "T-12", liters: 100, sessions: 2 },
            ],
          };
        case "/v1/operators":
          return {
            items: [
              { key: "op-0012", liters: 135.7, sessions: 2 },
              { key: "op-0007", liters: 84.3, sessions: 1 },
            ],
          };
        default:
          rows = [];
          return {
            items: [
              {
                deviceId: "pump-01",
                tankId: "tank-1",
                sessions: 3,
                lastReceivedAtMs: NOW_MS - 30 * 60_000,
              },
              { deviceId: "pump-02", tankId: "tank-2", sessions: 0, lastReceivedAtMs: null },
              {
                deviceId: "pump-03",
                tankId: "tank-3",
                sessions: 1,
                lastReceivedAtMs: NOW_MS - 3 * 86_400_000,
              },
            ],
          };
      }
    })();
    return { ok: true, status: 200, json: async () => body };
  };
  return { recorded, fetch };
}

async function setup(options: Parameters<typeof backend>[0] = {}, locale: "es" | "en" = "es") {
  const be = backend(options);
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      {
        provide: API_FACTORY,
        useValue: (token: string) => new ManagerApi({ baseUrl: "", token, fetch: be.fetch }),
      },
      { provide: NOW, useValue: () => NOW_MS },
      { provide: LOCALE, useValue: locale },
    ],
  });
  const fixture = TestBed.createComponent(App);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const text = () => el.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const type = async (selector: string, value: string) => {
    const input = el.querySelector(selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input"));
    await fixture.whenStable();
  };
  const signIn = async (token: string) => {
    await type("input[type=password]", token);
    (el.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit"));
    await fixture.whenStable();
    await fixture.whenStable();
  };
  const pick = async (selector: string, value: string) => {
    const select = el.querySelector(selector) as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new Event("change"));
    await fixture.whenStable();
    await fixture.whenStable();
  };
  const click = async (label: string) => {
    Array.from(el.querySelectorAll("button"))
      .find((b) => b.textContent?.trim() === label)
      ?.click();
    await fixture.whenStable();
    await fixture.whenStable();
  };
  return { el, text, signIn, pick, click, be, fixture };
}

describe("manager dashboard", () => {
  it("asks for the access key first", async () => {
    const { text, el } = await setup();
    expect(text()).toContain("Ingreso de gerencia");
    expect(el.querySelector("input[type=password]")).not.toBeNull();
    expect(text()).not.toContain("Litros despachados");
  });

  it("rejects a wrong key, stays signed out and keeps no key in the form", async () => {
    const { text, signIn, el } = await setup();
    await signIn("wrong-token-0123456789");
    expect(text()).toContain("La clave no es válida.");
    expect(text()).toContain("Ingreso de gerencia");
    expect((el.querySelector("input[type=password]") as HTMLInputElement).value).toBe("");
  });

  it("explains a server that cannot be reached", async () => {
    const { text, signIn } = await setup({ down: true });
    await signIn("good-token-0123456789");
    expect(text()).toContain("No hay conexión con el servidor.");
  });

  it("shows totals, shares, controllers and transactions after signing in", async () => {
    const { text, signIn, el } = await setup();
    await signIn("good-token-0123456789");
    expect(el.querySelector("[data-testid=kpi-liters]")?.textContent).toContain("220");
    expect(el.querySelector("[data-testid=kpi-sessions]")?.textContent).toContain("3");
    expect(el.querySelector("[data-testid=by-machine]")?.textContent).toContain("H-03");
    expect(el.querySelector("[data-testid=by-operator]")?.textContent).toContain("op-0012");
    expect(el.querySelectorAll("[data-testid=rows] tr").length).toBe(3);
    expect(text()).toContain("84,3 L");
    // Newest first, in the farm's time zone: 12:00 UTC is 09:00 in Argentina.
    expect(el.querySelector("[data-testid=rows] tr")?.textContent).toContain("09:00");
  });

  it("draws one bar for every day of the period, including empty days", async () => {
    const { signIn, el } = await setup();
    await signIn("good-token-0123456789");
    expect(el.querySelectorAll("app-bar-chart rect.bar").length).toBe(30);
  });

  it("marks controllers by how recently they synced without claiming they are down", async () => {
    const { signIn, el } = await setup();
    await signIn("good-token-0123456789");
    const items = Array.from(el.querySelectorAll("[data-testid=devices] li")).map((li) => ({
      text: li.textContent?.replace(/\s+/g, " ").trim() ?? "",
      health: li.querySelector(".dot")?.getAttribute("data-health"),
    }));
    expect(items[0]?.health).toBe("ok");
    expect(items[0]?.text).toContain("hace 30 min");
    expect(items[1]?.health).toBe("never");
    expect(items[1]?.text).toContain("Nunca sincronizó");
    expect(items[2]?.health).toBe("stale");
    expect(items[2]?.text).toContain("hace 3 d");
  });

  it("filters the transactions by equipment and asks the server for it", async () => {
    const { signIn, pick, el, be } = await setup();
    await signIn("good-token-0123456789");
    await pick("[data-testid=filter-machine]", "H-03");
    expect(el.querySelectorAll("[data-testid=rows] tr").length).toBe(1);
    expect(
      be.recorded.urls.some((u) => u.includes("/v1/transactions") && u.includes("machineId=H-03")),
    ).toBe(true);
  });

  it("drops filters when the period changes, so none stays active out of sight", async () => {
    const { signIn, pick, be } = await setup();
    await signIn("good-token-0123456789");
    await pick("[data-testid=filter-machine]", "H-03");
    await pick("header select", "7");
    const last = [...be.recorded.urls].reverse().find((u) => u.includes("/v1/transactions"));
    expect(last).not.toContain("machineId");
  });

  it("changes the period and reloads", async () => {
    const { signIn, pick, el, be } = await setup();
    await signIn("good-token-0123456789");
    const before = be.recorded.urls.length;
    await pick("header select", "7");
    expect(be.recorded.urls.length).toBeGreaterThan(before);
    expect(el.querySelectorAll("app-bar-chart rect.bar").length).toBe(7);
  });

  it("signs out and forgets the data", async () => {
    const { signIn, click, text } = await setup();
    await signIn("good-token-0123456789");
    await click("Salir");
    expect(text()).toContain("Ingreso de gerencia");
    expect(text()).not.toContain("Litros despachados");
  });

  it("switches language with the flag buttons without signing out", async () => {
    const { signIn, text, el, fixture } = await setup({}, "en");
    await signIn("good-token-0123456789");
    expect(text()).toContain("Liters dispensed");
    (el.querySelector("button[lang=es]") as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(text()).toContain("Litros despachados");
    expect(el.querySelector("[data-testid=kpi-liters]")).not.toBeNull();
    expect(document.documentElement.lang).toBe("es");
  });

  it("speaks English when asked", async () => {
    const { text } = await setup({}, "en");
    expect(text()).toContain("Manager sign in");
  });
});

describe("chart scale", () => {
  it("rounds the axis maximum up to a readable number", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(183)).toBe(200);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(2)).toBe(2);
    expect(niceMax(1000)).toBe(1000);
  });
});

describe("manager store", () => {
  it("ignores a slow older response that finishes after a newer one", async () => {
    const releases: ((rows: number) => void)[] = [];
    const fakeApi = {
      consumption: () =>
        new Promise((resolve) => {
          releases.push((n) =>
            resolve({ groupBy: "day", rows: [{ key: "2026-03-09", liters: n, sessions: 1 }] }),
          );
        }),
      machines: async () => ({ items: [] }),
      operators: async () => ({ items: [] }),
      devices: async () => ({ items: [] }),
      transactions: async () => ({ items: [], total: 0, limit: 10, offset: 0 }),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: API_FACTORY, useValue: () => fakeApi },
        { provide: NOW, useValue: () => NOW_MS },
      ],
    });
    const store = TestBed.inject(ManagerStore);
    const first = store.signIn("good-token-0123456789"); // 30 days
    await Promise.resolve();
    const second = store.setDays(7);
    await Promise.resolve();
    // The newer request answers first, then the older one.
    releases[1]?.(7);
    await second;
    releases[0]?.(30);
    await first;
    expect(store.data()?.days).toBe(7);
    expect(store.data()?.daily[0]?.liters).toBe(7);
    expect(store.loading()).toBe(false);
  });
});
