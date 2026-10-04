/*
 * Exportación a Excel (.xlsx real, Office Open XML).
 *
 * Recibe el resultado de runQuery() — el mismo objeto que pinta la vista de
 * estadísticas — de modo que el archivo y la pantalla siempre coinciden.
 *
 * Biblioteca: write-excel-file 4.1.1 (MIT), alojada en /vendor con versión
 * fija y verificación de integridad (SRI). Sólo se descarga la primera vez
 * que alguien exporta.
 *
 * Fechas y horas se escriben como números de serie de Excel con formato
 * dd/mm/aaaa y hh:mm:ss: son valores reales (se pueden ordenar, filtrar y
 * sumar) y no dependen de la zona horaria del equipo que abre el archivo.
 */

import {
  EXCUSE_FILTER_LABELS,
  NO_GROUP,
  bogotaParts,
  excelDateSerial,
  excelTimeFraction,
  makeDayKey
} from "./query.js";
import { describeFilters } from "./stats.js";

const LIBRARY_URL = new URL("./vendor/write-excel-file-4.1.1.min.js", import.meta.url).href;
const LIBRARY_INTEGRITY = "sha384-l2MfkSyI8avyb18vtz3IbErBv7TD1l7FiGCWmZyl0eumLsUrXUXjiA1cd+nMppir";

const HEADER_STYLE = {
  fontWeight: "bold",
  textColor: "#FFFFFF",
  backgroundColor: "#163A5F",
  alignVertical: "center"
};
const DATE_FORMAT = "dd/mm/yyyy";
const TIME_FORMAT = "hh:mm:ss";

let libraryPromise = null;

function loadLibrary() {
  if (window.writeXlsxFile) return Promise.resolve(window.writeXlsxFile);
  if (!libraryPromise) {
    libraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = LIBRARY_URL;
      script.integrity = LIBRARY_INTEGRITY;
      script.crossOrigin = "anonymous";
      script.async = true;
      script.onload = () => (window.writeXlsxFile ? resolve(window.writeXlsxFile) : reject(new Error("Biblioteca xlsx no disponible")));
      script.onerror = () => {
        libraryPromise = null; // permite reintentar si falló la red
        script.remove();
        reject(new Error("No se pudo cargar la biblioteca xlsx"));
      };
      document.head.append(script);
    });
  }
  return libraryPromise;
}

function header(values) {
  return values.map((value) => ({ value, ...HEADER_STYLE }));
}

function dateCell(dayKey) {
  return dayKey ? { value: excelDateSerial(dayKey), type: Number, format: DATE_FORMAT } : null;
}

function timeCell(seconds) {
  return seconds === null || seconds === undefined
    ? null
    : { value: excelTimeFraction(seconds), type: Number, format: TIME_FORMAT };
}

function textCell(value) {
  // Formato "@" (texto): Excel no convierte "10.2" en número ni "6.1" en fecha.
  return { value: value === undefined || value === null ? "" : String(value), type: String, format: "@" };
}

function groupName(group) {
  return group === NO_GROUP ? NO_GROUP : "Grupo " + group;
}

function generatedLabel(nowMs, generatedBy) {
  const parts = bogotaParts(nowMs);
  const pad = (value) => String(value).padStart(2, "0");
  return pad(parts.day) + "/" + pad(parts.month) + "/" + parts.year + " " +
    pad(parts.hour) + ":" + pad(parts.minute) + " (hora de Colombia) por " + generatedBy;
}

export function buildWorkbook(result, range, filters, generatedBy, nowMs) {
  const summary = [
    [{ value: "IERUU · Llegadas tarde", fontWeight: "bold", fontSize: 14, textColor: "#163A5F" }],
    [{ value: "Periodo", fontWeight: "bold" }, textCell(range.label)],
    [{ value: "Desde", fontWeight: "bold" }, dateCell(range.start)],
    [{ value: "Hasta", fontWeight: "bold" }, dateCell(range.end)],
    [{ value: "Filtros", fontWeight: "bold" }, textCell(describeFilters(filters))],
    [{ value: "Generado", fontWeight: "bold" }, textCell(generatedLabel(nowMs, generatedBy))],
    [],
    header(["Grupo", "Total", "Sin excusa", "Pendiente", "Validada", "Rechazada", "Estudiantes"])
  ];
  result.byGroup.forEach((row) => {
    summary.push([textCell(groupName(row.group)), row.total, row.sin, row.pendiente, row.validada, row.rechazada, row.students]);
  });
  const totals = result.totals;
  summary.push([
    { value: "Total", fontWeight: "bold", topBorderStyle: "thin", topBorderColor: "#163A5F" },
    ...[totals.total, totals.sin, totals.pendiente, totals.validada, totals.rechazada, totals.students].map((value) => ({
      value,
      type: Number,
      fontWeight: "bold",
      topBorderStyle: "thin",
      topBorderColor: "#163A5F"
    }))
  ]);

  const detail = [header([
    "Fecha",
    "Hora",
    "Estudiante",
    "Grupo",
    "Franja",
    "Estado de excusa",
    "Motivo",
    "Foto de evidencia",
    "UID de la tarjeta",
    "Observación"
  ])];
  result.events.forEach((event) => {
    detail.push([
      dateCell(event.day),
      timeCell(event.seconds),
      textCell(event.name),
      textCell(event.group === NO_GROUP ? NO_GROUP : event.group),
      textCell(event.franjaLabel),
      textCell(EXCUSE_FILTER_LABELS[event.excuse]),
      { value: event.reason || "", type: String, wrap: true },
      textCell(event.hasEvidence ? "Sí" : "No"),
      textCell(event.uid),
      textCell(event.removed ? "Ya no figura en estudiantes" : "")
    ]);
  });
  if (!result.events.length) {
    detail.push([textCell("Sin llegadas tarde en este periodo con los filtros elegidos.")]);
  }

  return [
    {
      data: summary,
      sheet: "Resumen",
      columns: [{ width: 22 }, { width: 46 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 13 }]
    },
    {
      data: detail,
      sheet: "Detalle",
      stickyRowsCount: 1,
      columns: [
        { width: 12 },
        { width: 10 },
        { width: 36 },
        { width: 10 },
        { width: 13 },
        { width: 17 },
        { width: 48 },
        { width: 17 },
        { width: 18 },
        { width: 28 }
      ]
    }
  ];
}

export function fileNameFor(range, nowMs) {
  const parts = bogotaParts(nowMs);
  const stamp = makeDayKey(parts.year, parts.month, parts.day);
  return "llegadas-tarde_" + range.fileTag + "_generado-" + stamp + ".xlsx";
}

export async function exportToXlsx(result, range, filters, generatedBy) {
  const writeXlsxFile = await loadLibrary();
  const nowMs = Date.now();
  const fileName = fileNameFor(range, nowMs);
  await writeXlsxFile(buildWorkbook(result, range, filters, generatedBy, nowMs), { fontFamily: "Calibri", fontSize: 11 }).toFile(fileName);
  return fileName;
}
