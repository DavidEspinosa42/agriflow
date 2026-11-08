import type { Notice, Snapshot } from "@agriflow/core";
import type { Locale } from "@agriflow/shared";

export interface Messages {
  readonly idleTitle: string;
  readonly idleHint: string;
  readonly machineTitle: string;
  readonly machineHint: string;
  readonly confirm: string;
  readonly erase: string;
  readonly authorizedTitle: string;
  readonly authorizedHint: string;
  readonly start: string;
  readonly cancel: string;
  readonly dispensingTitle: string;
  readonly stop: string;
  readonly finishedTitle: string;
  readonly ok: string;
  readonly total: string;
  readonly operator: string;
  readonly machine: string;
  readonly pumpOn: string;
  readonly pumpOff: string;
  readonly offline: string;
  readonly offlineStop: string;
  readonly estop: string;
  readonly estopHint: string;
  readonly lapsed: string;
  readonly denied: Readonly<Record<string, string>>;
  readonly faults: Readonly<Record<string, string>>;
  readonly fault: string;
  readonly endReasons: Readonly<Record<string, string>>;
}

const es: Messages = {
  idleTitle: "Acerque su llavero",
  idleHint: "para comenzar a cargar",
  machineTitle: "Ingrese el número de equipo",
  machineHint: "Por ejemplo T-12",
  confirm: "Aceptar",
  erase: "Borrar",
  authorizedTitle: "Listo para cargar",
  authorizedHint: "Presione INICIAR para activar la bomba",
  start: "INICIAR",
  cancel: "Cancelar",
  dispensingTitle: "Cargando",
  stop: "DETENER",
  finishedTitle: "Carga finalizada",
  ok: "Aceptar",
  total: "Total",
  operator: "Operador",
  machine: "Equipo",
  pumpOn: "Bomba encendida",
  pumpOff: "Bomba apagada",
  offline: "Sin conexión con el controlador",
  offlineStop: "Use el botón físico de parada",
  estop: "PARADA DE EMERGENCIA ACTIVA",
  estopHint: "Libere la parada de emergencia para continuar",
  lapsed: "La autorización venció. Vuelva a acercar el llavero.",
  denied: {
    unknown_credential: "Llavero no reconocido",
    credential_revoked: "Llavero dado de baja",
    credential_expired: "Llavero vencido",
    unknown_machine: "Equipo no encontrado",
    machine_inactive: "Equipo inactivo",
    machine_not_permitted: "No tiene permiso para este equipo",
  },
  faults: {
    estop_engaged: "Parada de emergencia activada",
    internal_error: "Error interno del sistema",
    implausible_flow: "Caudal anormal detectado",
    storage_failure: "No se pudo guardar la carga",
  },
  fault: "Falla del sistema",
  endReasons: {
    operator_stop: "Detenida por el operador",
    max_liters: "Límite de litros alcanzado",
    idle_timeout: "Detenida por inactividad",
    fault: "Detenida por una falla",
    estop: "Parada de emergencia",
    interrupted: "Interrumpida",
  },
};

const en: Messages = {
  idleTitle: "Present your fob",
  idleHint: "to start fueling",
  machineTitle: "Enter the equipment number",
  machineHint: "For example T-12",
  confirm: "Confirm",
  erase: "Erase",
  authorizedTitle: "Ready to fuel",
  authorizedHint: "Press START to switch the pump on",
  start: "START",
  cancel: "Cancel",
  dispensingTitle: "Fueling",
  stop: "STOP",
  finishedTitle: "Fueling finished",
  ok: "OK",
  total: "Total",
  operator: "Operator",
  machine: "Equipment",
  pumpOn: "Pump on",
  pumpOff: "Pump off",
  offline: "No connection to the controller",
  offlineStop: "Use the physical stop button",
  estop: "EMERGENCY STOP ACTIVE",
  estopHint: "Release the emergency stop to continue",
  lapsed: "The authorization expired. Present the fob again.",
  denied: {
    unknown_credential: "Fob not recognized",
    credential_revoked: "Fob has been revoked",
    credential_expired: "Fob has expired",
    unknown_machine: "Equipment not found",
    machine_inactive: "Equipment is inactive",
    machine_not_permitted: "You are not allowed to fuel this equipment",
  },
  faults: {
    estop_engaged: "Emergency stop engaged",
    internal_error: "Internal system error",
    implausible_flow: "Abnormal flow detected",
    storage_failure: "The fueling could not be saved",
  },
  fault: "System fault",
  endReasons: {
    operator_stop: "Stopped by the operator",
    max_liters: "Liter limit reached",
    idle_timeout: "Stopped after inactivity",
    fault: "Stopped by a fault",
    estop: "Emergency stop",
    interrupted: "Interrupted",
  },
};

const ALL: Readonly<Record<Locale, Messages>> = { es, en };

export function messagesFor(locale: Locale): Messages {
  return ALL[locale];
}

/** Text for the notice banner, or null when there is nothing to tell the operator. */
export function noticeText(notice: Notice, m: Messages): string | null {
  switch (notice.kind) {
    case "none":
      return null;
    case "denied":
      return m.denied[notice.reason] ?? m.fault;
    case "lapsed":
      return m.lapsed;
    case "fault":
      return m.faults[notice.reason] ?? m.fault;
  }
}

export function endReasonText(reason: Snapshot["endReason"], m: Messages): string {
  return reason === null ? "" : (m.endReasons[reason] ?? "");
}
