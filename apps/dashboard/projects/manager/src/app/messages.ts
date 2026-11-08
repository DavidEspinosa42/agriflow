import type { ApiErrorKind, Locale } from "@agriflow/shared";

export interface Messages {
  readonly title: string;
  readonly loginTitle: string;
  readonly tokenLabel: string;
  readonly signIn: string;
  readonly signOut: string;
  readonly refresh: string;
  readonly period: string;
  readonly days: (n: number) => string;
  readonly totalLiters: string;
  readonly sessions: string;
  readonly average: string;
  readonly machinesInUse: string;
  readonly dailyTitle: string;
  readonly byMachine: string;
  readonly byOperator: string;
  readonly controllers: string;
  readonly transactions: string;
  readonly machine: string;
  readonly operator: string;
  readonly date: string;
  readonly liters: string;
  readonly reason: string;
  readonly synced: string;
  readonly all: string;
  readonly previous: string;
  readonly next: string;
  readonly pageOf: (from: number, to: number, total: number) => string;
  readonly noData: string;
  readonly loading: string;
  readonly health: Readonly<Record<"ok" | "stale" | "never", string>>;
  readonly lastSync: string;
  readonly ago: (age: string) => string;
  readonly errors: Readonly<Record<ApiErrorKind, string>>;
  readonly endReasons: Readonly<Record<string, string>>;
}

const es: Messages = {
  title: "AgriFlow · Combustible",
  loginTitle: "Ingreso de gerencia",
  tokenLabel: "Clave de acceso",
  signIn: "Ingresar",
  signOut: "Salir",
  refresh: "Actualizar",
  period: "Período",
  days: (n) => `Últimos ${n} días`,
  totalLiters: "Litros despachados",
  sessions: "Cargas",
  average: "Promedio por carga",
  machinesInUse: "Equipos que cargaron",
  dailyTitle: "Consumo diario",
  byMachine: "Por equipo",
  byOperator: "Por operador",
  controllers: "Controladores",
  transactions: "Últimas cargas",
  machine: "Equipo",
  operator: "Operador",
  date: "Fecha",
  liters: "Litros",
  reason: "Fin",
  synced: "Recibida",
  all: "Todos",
  previous: "Anterior",
  next: "Siguiente",
  pageOf: (from, to, total) => `${from}–${to} de ${total}`,
  noData: "Sin datos en este período",
  loading: "Cargando…",
  health: { ok: "Al día", stale: "Sin novedades", never: "Nunca sincronizó" },
  lastSync: "Última sincronización",
  ago: (age) => `hace ${age}`,
  errors: {
    unauthorized: "La clave no es válida.",
    invalid_query: "La consulta no es válida.",
    server: "El servidor no pudo responder. Intente de nuevo.",
    network: "No hay conexión con el servidor.",
    invalid_response: "El servidor respondió algo inesperado.",
  },
  endReasons: {
    operator_stop: "Operador",
    max_liters: "Límite de litros",
    idle_timeout: "Inactividad",
    fault: "Falla",
    estop: "Emergencia",
    interrupted: "Interrumpida",
  },
};

const en: Messages = {
  title: "AgriFlow · Fuel",
  loginTitle: "Manager sign in",
  tokenLabel: "Access key",
  signIn: "Sign in",
  signOut: "Sign out",
  refresh: "Refresh",
  period: "Period",
  days: (n) => `Last ${n} days`,
  totalLiters: "Liters dispensed",
  sessions: "Fuelings",
  average: "Average per fueling",
  machinesInUse: "Equipment fueled",
  dailyTitle: "Daily consumption",
  byMachine: "By equipment",
  byOperator: "By operator",
  controllers: "Controllers",
  transactions: "Latest fuelings",
  machine: "Equipment",
  operator: "Operator",
  date: "Date",
  liters: "Liters",
  reason: "Ended",
  synced: "Received",
  all: "All",
  previous: "Previous",
  next: "Next",
  pageOf: (from, to, total) => `${from}–${to} of ${total}`,
  noData: "No data in this period",
  loading: "Loading…",
  health: { ok: "Up to date", stale: "No news", never: "Never synced" },
  lastSync: "Last sync",
  ago: (age) => `${age} ago`,
  errors: {
    unauthorized: "The key is not valid.",
    invalid_query: "The request is not valid.",
    server: "The server could not respond. Try again.",
    network: "Cannot reach the server.",
    invalid_response: "The server sent something unexpected.",
  },
  endReasons: {
    operator_stop: "Operator",
    max_liters: "Liter limit",
    idle_timeout: "Inactivity",
    fault: "Fault",
    estop: "Emergency",
    interrupted: "Interrupted",
  },
};

export function messagesFor(locale: Locale): Messages {
  return locale === "en" ? en : es;
}
