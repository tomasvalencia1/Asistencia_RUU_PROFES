// Pruebas del módulo de consulta. Ejecutar desde la carpeta tests: npm run test:query
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  periodRange,
  todayKey,
  weekStart,
  normalizeLateEvents,
  runQuery,
  monthOptions,
  excelDateSerial,
  GROUPS,
  NO_GROUP
} from "../query.js";

const at = (iso) => Date.parse(iso);

test("hoy usa America/Bogota aunque en UTC ya sea el día siguiente", () => {
  // 3 de octubre de 2026, 22:30 en Bogotá = 4 de octubre 03:30 UTC.
  assert.equal(todayKey(at("2026-10-04T03:30:00Z")), "2026-10-03");
  assert.equal(todayKey(at("2026-10-04T05:00:00Z")), "2026-10-04");
});

test("la semana va de lunes a domingo", () => {
  assert.equal(weekStart("2026-10-04"), "2026-09-28"); // domingo
  assert.equal(weekStart("2026-09-28"), "2026-09-28"); // lunes
  const week = periodRange({ type: "semana" }, at("2026-10-04T15:00:00Z"));
  assert.equal(week.start, "2026-09-28");
  assert.equal(week.end, "2026-10-04");
  assert.match(week.label, /lunes, 28 de septiembre de 2026 al domingo, 4 de octubre de 2026/);
});

test("semana que cruza el cambio de año", () => {
  const week = periodRange({ type: "semana-de", value: "2027-01-01" });
  assert.equal(week.start, "2026-12-28");
  assert.equal(week.end, "2027-01-03");
});

test("mes anterior desde enero es diciembre del año previo", () => {
  const range = periodRange({ type: "mes-anterior" }, at("2027-01-15T15:00:00Z"));
  assert.equal(range.start, "2026-12-01");
  assert.equal(range.end, "2026-12-31");
  assert.equal(range.label, "Diciembre de 2026");
});

test("febrero bisiesto y valores inválidos", () => {
  assert.equal(periodRange({ type: "mes-de", value: "2028-02" }).end, "2028-02-29");
  const fallback = periodRange({ type: "dia", value: "2026-02-30" }, at("2026-10-03T15:00:00Z"));
  assert.equal(fallback.start, "2026-10-03");
});

const students = {
  AA01: { nombre: "José Peña Muñoz", grupo: "6.1", llegadasTarde: 2 },
  BB02: { nombre: "Ana Gómez", grupo: "10.2", llegadasTarde: 1 }
};

const records = {
  r1: { uid: "AA01", nombre: "José Peña Muñoz", grupo: "6.1", fecha: "2026-10-01", hora: "07:05:00", timestamp: at("2026-10-01T12:05:00Z"), periodo: "entrada", tarde: true },
  r2: { uid: "AA01", nombre: "José Peña Muñoz", grupo: "6.1", fecha: "2026-10-02", hora: "09:15:10", timestamp: at("2026-10-02T14:15:10Z"), periodo: "descanso1", tarde: true, justificacion: { estado: "validada", motivo: "Cita médica", revisadaPorUid: "x", revisadaEn: 1 } },
  r3: { uid: "BB02", nombre: "Ana Gómez", grupo: 102, fecha: "2026-09-30", hora: "07:01:00", timestamp: at("2026-09-30T12:01:00Z"), periodo: "entrada", tarde: "true", justificacion: { estado: "raro", motivo: "?" } },
  r4: { uid: "CC03", nombre: "Retirado Ñañez", grupo: "x", fecha: "2026-10-02", hora: "12:20:00", timestamp: at("2026-10-02T17:20:00Z"), periodo: "descanso2", tarde: true },
  r5: { uid: "AA01", nombre: "José Peña Muñoz", grupo: "6.1", fecha: "2026-10-02", hora: "06:50:00", timestamp: 1, periodo: "entrada", tarde: false },
  r6: { uid: "", nombre: "Sin UID", grupo: "6.1", fecha: "2026-10-02", hora: "07:00:01", timestamp: 1, periodo: "entrada", tarde: true },
  r7: { uid: "AA01", nombre: "José Peña Muñoz", grupo: "6.1", fecha: "malo", hora: "", timestamp: at("2026-10-03T02:30:00Z"), periodo: "entrada", tarde: true }
};

test("normalización: mismo criterio de inclusión del panel y respaldo con timestamp", () => {
  const events = normalizeLateEvents(records, students, { r2: { version: 1 } });
  const ids = events.map((event) => event.id).sort();
  assert.deepEqual(ids, ["r1", "r2", "r3", "r4", "r7"]);
  const byId = Object.fromEntries(events.map((event) => [event.id, event]));
  assert.equal(byId.r3.group, "10.2"); // grupo numérico heredado 102
  assert.equal(byId.r3.excuse, "pendiente"); // estado desconocido se trata como pendiente
  assert.equal(byId.r4.group, NO_GROUP);
  assert.equal(byId.r4.removed, true);
  assert.equal(byId.r2.hasEvidence, true);
  // 2026-10-03T02:30Z son las 21:30 del 2 de octubre en Bogotá.
  assert.equal(byId.r7.day, "2026-10-02");
  assert.equal(byId.r7.time, "21:30:00");
});

test("consulta combinada, búsqueda sin tildes y totales coherentes", () => {
  const events = normalizeLateEvents(records, students, {});
  const week = periodRange({ type: "semana-de", value: "2026-10-01" });
  const all = runQuery(events, week, {});
  assert.equal(all.total, 5);
  assert.equal(all.students, 3);
  assert.equal(all.byGroup.reduce((sum, row) => sum + row.total, 0), all.total);
  assert.equal(all.byGroup.length, GROUPS.length + 1); // 18 grupos + "Sin grupo"
  assert.equal(all.byGroup.at(-1).group, NO_GROUP);
  assert.equal(all.totals.validada, 1);
  assert.equal(all.totals.sin + all.totals.pendiente + all.totals.validada + all.totals.rechazada, all.total);
  // Orden: más reciente primero.
  assert.equal(all.events[0].id, "r7");

  assert.equal(runQuery(events, week, { name: "jose pena" }).total, 3);
  assert.equal(runQuery(events, week, { name: "ÑAÑEZ" }).total, 1);
  assert.equal(runQuery(events, week, { group: "6.1", franja: "entrada" }).total, 2);
  assert.equal(runQuery(events, week, { excuse: "sin" }).total, 3);
  const onlyGroup = runQuery(events, week, { group: "10.2" });
  assert.equal(onlyGroup.byGroup.length, 1);
  assert.equal(onlyGroup.total, 1);
});

test("periodo sin datos devuelve ceros, no errores", () => {
  const events = normalizeLateEvents(records, students, {});
  const empty = runQuery(events, periodRange({ type: "mes-de", value: "2026-07" }), {});
  assert.equal(empty.total, 0);
  assert.equal(empty.events.length, 0);
  assert.ok(empty.byGroup.every((row) => row.total === 0));
});

test("opciones de mes y serial de Excel", () => {
  const options = monthOptions([], at("2026-10-03T15:00:00Z"));
  assert.equal(options[0].value, "2026-10");
  assert.equal(options.length, 12);
  assert.equal(excelDateSerial("2026-10-03"), 46298);
  assert.equal(excelDateSerial("1900-03-01"), 61);
});
