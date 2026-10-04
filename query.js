/*
 * Módulo único de consulta de llegadas tarde.
 *
 * La vista de estadísticas y la exportación a Excel usan exclusivamente
 * estas funciones; por eso nunca pueden dar cifras distintas. El módulo es
 * puro (no toca el DOM ni Firebase) y se prueba con `node --test` desde la
 * carpeta tests.
 *
 * Fechas: el día de cada registro es el texto `fecha` (AAAA-MM-DD) que escribe
 * el lector Android con la hora de Colombia. Todos los cálculos de "hoy",
 * semana (lunes a domingo) y mes se hacen en America/Bogota con Intl, sin
 * depender de la zona horaria del navegador.
 */

export const TIME_ZONE = "America/Bogota";

export const GROUPS = [];
for (let grade = 6; grade <= 11; grade += 1) {
  for (let section = 1; section <= 3; section += 1) {
    GROUPS.push(String(grade) + "." + String(section));
  }
}

export const NO_GROUP = "Sin grupo";

export const FRANJA_LABELS = {
  entrada: "Entrada",
  descanso1: "Descanso 1",
  descanso2: "Descanso 2"
};

export const EXCUSE_STATES = ["sin", "pendiente", "validada", "rechazada"];
export const EXCUSE_FILTER_LABELS = {
  sin: "Sin excusa",
  pendiente: "Pendiente",
  validada: "Validada",
  rechazada: "Rechazada"
};

export const PERIOD_TYPES = {
  hoy: "Hoy",
  semana: "Esta semana",
  mes: "Este mes",
  "mes-anterior": "Mes anterior",
  dia: "Un día específico",
  "semana-de": "Una semana específica",
  "mes-de": "Un mes específico"
};

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_KEY = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
const MS_PER_DAY = 86400000;

const bogotaFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
});

// Los nombres de días y meses se formatean sobre fechas UTC "abstractas" para
// que el navegador no desplace el día según su zona horaria.
const longDayFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "UTC",
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric"
});
const shortDayFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric"
});
const monthNameFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "UTC",
  month: "long",
  year: "numeric"
});

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

export function searchText(value) {
  return text(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("es-CO");
}

export function uidKey(value) {
  return text(value).replace(/[:\s-]/g, "").toUpperCase();
}

export function normalizeGroup(value) {
  const raw = text(value).replace(",", ".").replace(/\s+/g, "");
  const withSeparator = raw.match(/^(6|7|8|9|10|11)\.([1-3])$/);
  if (withSeparator) return withSeparator[1] + "." + withSeparator[2];
  const compact = raw.match(/^(6|7|8|9|10|11)([1-3])$/);
  if (compact) return compact[1] + "." + compact[2];
  return "";
}

/* ---------- Fechas en America/Bogota ---------- */

export function bogotaParts(milliseconds) {
  const parts = {};
  bogotaFormatter.formatToParts(new Date(milliseconds)).forEach((part) => {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  });
  return parts;
}

export function todayKey(nowMs) {
  const parts = bogotaParts(nowMs === undefined ? Date.now() : nowMs);
  return makeDayKey(parts.year, parts.month, parts.day);
}

export function makeDayKey(year, month, day) {
  return String(year) + "-" + pad(month) + "-" + pad(day);
}

export function isDayKey(value) {
  const match = text(value).match(DAY_KEY);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function dayNumber(key) {
  const match = key.match(DAY_KEY);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / MS_PER_DAY;
}

export function keyFromDayNumber(number) {
  const date = new Date(number * MS_PER_DAY);
  return makeDayKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function addDays(key, amount) {
  return keyFromDayNumber(dayNumber(key) + amount);
}

// 0 = lunes … 6 = domingo.
export function weekdayFromMonday(key) {
  return (new Date(dayNumber(key) * MS_PER_DAY).getUTCDay() + 6) % 7;
}

export function weekStart(key) {
  return addDays(key, -weekdayFromMonday(key));
}

export function monthKeyOf(key) {
  return key.slice(0, 7);
}

export function monthBounds(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: makeDayKey(year, month, 1), end: makeDayKey(year, month, lastDay) };
}

export function shiftMonth(monthKey, amount) {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + amount, 1));
  return String(date.getUTCFullYear()) + "-" + pad(date.getUTCMonth() + 1);
}

function utcDate(key) {
  return new Date(dayNumber(key) * MS_PER_DAY);
}

export function formatDayLong(key) {
  return longDayFormatter.format(utcDate(key));
}

export function formatDayShort(key) {
  return shortDayFormatter.format(utcDate(key)).replace(/\./g, "");
}

export function formatMonth(monthKey) {
  return capitalize(monthNameFormatter.format(utcDate(monthKey + "-01")));
}

/*
 * Convierte la elección de periodo en un rango cerrado de días [start, end].
 * spec = { type: "hoy" | "semana" | "mes" | "mes-anterior" | "dia" | "semana-de" | "mes-de", value }
 * value es AAAA-MM-DD para "dia" y "semana-de" (cualquier día de esa semana)
 * y AAAA-MM para "mes-de".
 */
export function periodRange(spec, nowMs) {
  const type = spec && PERIOD_TYPES[spec.type] ? spec.type : "hoy";
  const today = todayKey(nowMs);
  const value = text(spec && spec.value);

  if (type === "hoy" || type === "dia") {
    const day = type === "dia" && isDayKey(value) ? value : today;
    return {
      kind: "dia",
      start: day,
      end: day,
      label: capitalize(formatDayLong(day)),
      fileTag: "dia_" + day
    };
  }

  if (type === "semana" || type === "semana-de") {
    const anchor = type === "semana-de" && isDayKey(value) ? value : today;
    const start = weekStart(anchor);
    const end = addDays(start, 6);
    return {
      kind: "semana",
      start,
      end,
      label: "Semana del " + formatDayLong(start) + " al " + formatDayLong(end),
      fileTag: "semana_" + start + "_a_" + end
    };
  }

  let month = monthKeyOf(today);
  if (type === "mes-anterior") month = shiftMonth(month, -1);
  if (type === "mes-de" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)) month = value;
  const bounds = monthBounds(month);
  return {
    kind: "mes",
    start: bounds.start,
    end: bounds.end,
    label: formatMonth(month),
    fileTag: "mes_" + month
  };
}

/* ---------- Normalización de registros ---------- */

function secondsOf(timeKey) {
  const match = text(timeKey).match(TIME_KEY);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function formatSeconds(seconds) {
  if (seconds === null || seconds === undefined) return "";
  return pad(Math.floor(seconds / 3600)) + ":" + pad(Math.floor((seconds % 3600) / 60)) + ":" + pad(seconds % 60);
}

export function excuseStateOf(justification) {
  if (!justification || typeof justification !== "object") return "sin";
  const value = text(justification.estado);
  // El panel actual muestra como "Pendiente" cualquier estado desconocido; se replica aquí.
  return value === "validada" || value === "rechazada" ? value : "pendiente";
}

export function franjaLabel(key) {
  const value = text(key);
  if (!value) return "Sin franja";
  return FRANJA_LABELS[value] || value;
}

/*
 * Devuelve todas las llegadas tarde como objetos planos. Usa el mismo criterio
 * de inclusión del panel (tarde === true y UID válido) e incluye también los
 * registros de estudiantes ya retirados, marcados con `retirado`.
 */
export function normalizeLateEvents(records, students, evidence) {
  const studentMap = new Map();
  Object.entries(students || {}).forEach(([uid, student]) => {
    if (student && typeof student === "object") studentMap.set(uidKey(uid), student);
  });
  const evidenceMap = evidence || {};
  const events = [];

  Object.entries(records || {}).forEach(([id, record]) => {
    if (!record || typeof record !== "object") return;
    if (record.tarde !== true && record.tarde !== "true") return;
    const uid = uidKey(record.uid);
    if (!uid) return;

    const student = studentMap.get(uid);
    const timestamp = Number(record.timestamp);
    const hasTimestamp = Number.isFinite(timestamp) && timestamp > 0;
    const stamp = hasTimestamp ? bogotaParts(timestamp) : null;

    let day = text(record.fecha);
    if (!isDayKey(day)) day = stamp ? makeDayKey(stamp.year, stamp.month, stamp.day) : "";
    let seconds = secondsOf(record.hora);
    if (seconds === null && stamp) seconds = stamp.hour * 3600 + stamp.minute * 60 + stamp.second;

    const group = normalizeGroup(record.grupo) || normalizeGroup(student && student.grupo) || NO_GROUP;
    const name = text(record.nombre) || text(student && student.nombre) || "Sin nombre";
    const justification = record.justificacion && typeof record.justificacion === "object"
      ? record.justificacion
      : null;
    const franja = text(record.periodo);

    events.push({
      id,
      uid,
      name,
      searchName: searchText(name),
      group,
      day,
      seconds,
      time: formatSeconds(seconds),
      franja,
      franjaLabel: franjaLabel(franja),
      excuse: excuseStateOf(justification),
      reason: text(justification && justification.motivo),
      hasEvidence: Boolean(evidenceMap[id]),
      removed: !student
    });
  });

  return events;
}

function compareEvents(first, second) {
  if (first.day !== second.day) return first.day < second.day ? 1 : -1;
  const firstSeconds = first.seconds === null ? -1 : first.seconds;
  const secondSeconds = second.seconds === null ? -1 : second.seconds;
  if (firstSeconds !== secondSeconds) return secondSeconds - firstSeconds;
  return first.name.localeCompare(second.name, "es-CO");
}

function groupOrder(group) {
  const index = GROUPS.indexOf(group);
  return index === -1 ? GROUPS.length : index;
}

/*
 * filters = { group, franja, excuse, name } — cadenas vacías significan "todos".
 * range = resultado de periodRange().
 */
export function runQuery(events, range, filters) {
  const options = filters || {};
  const nameQuery = searchText(options.name);
  const matched = events.filter((event) => {
    if (!event.day || event.day < range.start || event.day > range.end) return false;
    if (options.group && event.group !== options.group) return false;
    if (options.franja && event.franja !== options.franja) return false;
    if (options.excuse && event.excuse !== options.excuse) return false;
    if (nameQuery && !event.searchName.includes(nameQuery)) return false;
    return true;
  });
  matched.sort(compareEvents);

  const groups = new Map();
  const listedGroups = options.group ? [options.group] : [...GROUPS];
  listedGroups.forEach((group) => groups.set(group, emptyGroupRow(group)));

  const totals = emptyGroupRow("Total");
  const students = new Set();
  matched.forEach((event) => {
    if (!groups.has(event.group)) groups.set(event.group, emptyGroupRow(event.group));
    const row = groups.get(event.group);
    row.total += 1;
    row[event.excuse] += 1;
    row.studentSet.add(event.uid);
    totals.total += 1;
    totals[event.excuse] += 1;
    students.add(event.uid);
  });

  const byGroup = [...groups.values()]
    .sort((first, second) => groupOrder(first.group) - groupOrder(second.group))
    .map(finishGroupRow);
  totals.studentSet = students;

  return {
    events: matched,
    total: matched.length,
    students: students.size,
    byGroup,
    totals: finishGroupRow(totals)
  };
}

function emptyGroupRow(group) {
  return { group, total: 0, sin: 0, pendiente: 0, validada: 0, rechazada: 0, studentSet: new Set() };
}

function finishGroupRow(row) {
  const { studentSet, ...rest } = row;
  return { ...rest, students: studentSet.size };
}

/* Opciones de franja: las tres conocidas más cualquier otro valor presente en los datos. */
export function franjaOptions(events) {
  const keys = new Set(Object.keys(FRANJA_LABELS));
  events.forEach((event) => {
    if (event.franja) keys.add(event.franja);
  });
  return [...keys].map((key) => ({ value: key, label: franjaLabel(key) }));
}

/* Meses disponibles para "Un mes específico": del mes actual hacia atrás hasta el registro más antiguo (mínimo 12). */
export function monthOptions(events, nowMs) {
  const current = monthKeyOf(todayKey(nowMs));
  let oldest = shiftMonth(current, -11);
  events.forEach((event) => {
    if (event.day && monthKeyOf(event.day) < oldest) oldest = monthKeyOf(event.day);
  });
  const options = [];
  for (let month = current; month >= oldest; month = shiftMonth(month, -1)) {
    options.push({ value: month, label: formatMonth(month) });
  }
  return options;
}

/* Días seriales de Excel (sistema 1900): 1899-12-30 es el día 0. */
export function excelDateSerial(key) {
  return dayNumber(key) - dayNumber("1899-12-30");
}

export function excelTimeFraction(seconds) {
  return seconds / 86400;
}
