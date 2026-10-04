/*
 * Vista "Estadísticas y Excel".
 *
 * Disponible para todos los roles: sólo lee datos que el panel ya tiene en
 * memoria (los mismos que cada rol puede leer según database.rules.json), así
 * que no genera lecturas adicionales en Realtime Database. La exportación usa
 * el resultado de la misma consulta que se muestra en pantalla.
 */

import {
  EXCUSE_FILTER_LABELS,
  GROUPS,
  NO_GROUP,
  formatDayShort,
  franjaLabel,
  franjaOptions,
  monthKeyOf,
  monthOptions,
  periodRange,
  runQuery,
  todayKey
} from "./query.js";

const PAGE_SIZE = 200;

function element(tagName, className, content) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function plural(count, singular, pluralForm) {
  return String(count) + " " + (count === 1 ? singular : pluralForm);
}

export function createStatsView(options) {
  const $ = (selector) => document.querySelector(selector);
  const nodes = {
    dialog: $("#statsDialog"),
    form: $("#statsForm"),
    periodInputs: [...document.querySelectorAll("input[name='statsPeriod']")],
    dayField: $("#statsDayField"),
    dayInput: $("#statsDayInput"),
    weekField: $("#statsWeekField"),
    weekInput: $("#statsWeekInput"),
    monthField: $("#statsMonthField"),
    monthInput: $("#statsMonthInput"),
    groupInput: $("#statsGroupInput"),
    franjaInput: $("#statsFranjaInput"),
    excuseInput: $("#statsExcuseInput"),
    nameInput: $("#statsNameInput"),
    resetButton: $("#statsResetButton"),
    rangeLabel: $("#statsRangeLabel"),
    total: $("#statsTotal"),
    students: $("#statsStudents"),
    withoutExcuse: $("#statsWithoutExcuse"),
    validated: $("#statsValidated"),
    showEmptyGroups: $("#statsShowEmptyGroups"),
    groupTableBody: $("#statsGroupTableBody"),
    groupTableFoot: $("#statsGroupTableFoot"),
    listHeading: $("#statsListHeading"),
    list: $("#statsList"),
    moreButton: $("#statsMoreButton"),
    exportButton: $("#statsExportButton"),
    exportStatus: $("#statsExportStatus")
  };

  const view = {
    visibleCount: PAGE_SIZE,
    lastResult: null,
    lastRange: null,
    lastFilters: null
  };

  function populateStaticOptions() {
    nodes.groupInput.replaceChildren(new Option("Todos los grupos", ""));
    GROUPS.forEach((group) => nodes.groupInput.append(new Option("Grupo " + group, group)));
    nodes.groupInput.append(new Option(NO_GROUP, NO_GROUP));

    nodes.excuseInput.replaceChildren(new Option("Todos los estados", ""));
    Object.entries(EXCUSE_FILTER_LABELS).forEach(([value, label]) => {
      nodes.excuseInput.append(new Option(label, value));
    });
  }

  // Las franjas y los meses dependen de los datos; se reconstruyen conservando la selección.
  function populateDynamicOptions(events) {
    const currentFranja = nodes.franjaInput.value;
    nodes.franjaInput.replaceChildren(new Option("Todas las franjas", ""));
    franjaOptions(events).forEach((option) => nodes.franjaInput.append(new Option(option.label, option.value)));
    nodes.franjaInput.value = currentFranja;
    if (nodes.franjaInput.value !== currentFranja) nodes.franjaInput.value = "";

    const currentMonth = nodes.monthInput.value || monthKeyOf(todayKey());
    nodes.monthInput.replaceChildren();
    monthOptions(events).forEach((option) => nodes.monthInput.append(new Option(option.label, option.value)));
    nodes.monthInput.value = currentMonth;
    if (nodes.monthInput.value !== currentMonth) nodes.monthInput.selectedIndex = 0;
  }

  function selectedPeriodType() {
    const checked = nodes.periodInputs.find((input) => input.checked);
    return checked ? checked.value : "hoy";
  }

  function currentSpec() {
    const type = selectedPeriodType();
    if (type === "dia") return { type, value: nodes.dayInput.value };
    if (type === "semana-de") return { type, value: nodes.weekInput.value };
    if (type === "mes-de") return { type, value: nodes.monthInput.value };
    return { type };
  }

  function currentFilters() {
    return {
      group: nodes.groupInput.value,
      franja: nodes.franjaInput.value,
      excuse: nodes.excuseInput.value,
      name: nodes.nameInput.value
    };
  }

  function syncPickers() {
    const type = selectedPeriodType();
    nodes.dayField.hidden = type !== "dia";
    nodes.weekField.hidden = type !== "semana-de";
    nodes.monthField.hidden = type !== "mes-de";
  }

  function renderGroupTable(result) {
    nodes.groupTableBody.replaceChildren();
    const showEmpty = nodes.showEmptyGroups.checked;
    const rows = result.byGroup.filter((row) => showEmpty || row.total > 0);
    if (!rows.length) {
      const emptyRow = element("tr");
      const cell = element("td", "stats-table-empty", "Ningún grupo tiene llegadas tarde en este periodo con estos filtros.");
      cell.colSpan = 7;
      emptyRow.append(cell);
      nodes.groupTableBody.append(emptyRow);
    }
    rows.forEach((row) => nodes.groupTableBody.append(groupRow(row, row.group === NO_GROUP ? NO_GROUP : "Grupo " + row.group, "td")));
    nodes.groupTableFoot.replaceChildren(groupRow(result.totals, "Total", "th"));
  }

  function groupRow(row, label, cellTag) {
    const tableRow = element("tr");
    const head = element("th", "", label);
    head.scope = "row";
    tableRow.append(head);
    [row.total, row.sin, row.pendiente, row.validada, row.rechazada, row.students].forEach((value) => {
      tableRow.append(element(cellTag, "numeric", String(value)));
    });
    return tableRow;
  }

  function renderList(result) {
    nodes.list.replaceChildren();
    const visible = result.events.slice(0, view.visibleCount);
    nodes.listHeading.textContent = result.total
      ? "Listado · " + (visible.length < result.total
        ? "mostrando " + visible.length + " de " + result.total
        : plural(result.total, "registro", "registros"))
      : "Listado";

    if (!result.total) {
      nodes.list.append(element("li", "stats-list-empty", "No hay llegadas tarde en este periodo con los filtros elegidos."));
    }

    visible.forEach((event) => {
      const item = element("li", "stats-item");
      const when = element("div", "stats-item-when");
      when.append(element("strong", "", event.day ? formatDayShort(event.day) : "Sin fecha"));
      when.append(element("span", "", event.time || "—"));

      const who = element("div", "stats-item-who");
      who.append(element("strong", "", event.name));
      const meta = element("span", "", (event.group === NO_GROUP ? NO_GROUP : "Grupo " + event.group) + " · " + event.franjaLabel);
      who.append(meta);
      if (event.removed) who.append(element("span", "stats-tag", "Ya no figura en estudiantes"));

      const excuse = element("div", "stats-item-excuse");
      excuse.append(element("span", "state-pill state-" + (event.excuse === "sin" ? "empty" : event.excuse), EXCUSE_FILTER_LABELS[event.excuse]));
      if (event.hasEvidence) excuse.append(element("span", "stats-tag", "Con foto"));

      item.append(when, who, excuse);
      nodes.list.append(item);
    });

    nodes.moreButton.hidden = visible.length >= result.total;
  }

  function refresh() {
    if (!nodes.dialog.open) return;
    const events = options.getEvents();
    populateDynamicOptions(events);
    syncPickers();
    const range = periodRange(currentSpec());
    const filters = currentFilters();
    const result = runQuery(events, range, filters);
    view.lastResult = result;
    view.lastRange = range;
    view.lastFilters = filters;

    nodes.rangeLabel.textContent = range.label + " · zona horaria de Colombia";
    nodes.total.textContent = String(result.total);
    nodes.students.textContent = String(result.students);
    nodes.withoutExcuse.textContent = String(result.totals.sin);
    nodes.validated.textContent = String(result.totals.validada);
    renderGroupTable(result);
    renderList(result);
    if (nodes.exportButton) nodes.exportButton.disabled = false;
  }

  function resetPaging() {
    view.visibleCount = PAGE_SIZE;
    refresh();
  }

  function open() {
    const today = todayKey();
    if (!nodes.dayInput.value) nodes.dayInput.value = today;
    if (!nodes.weekInput.value) nodes.weekInput.value = today;
    if (nodes.exportStatus) {
      nodes.exportStatus.textContent = "";
      nodes.exportStatus.classList.remove("error");
    }
    if (typeof nodes.dialog.showModal === "function") nodes.dialog.showModal();
    resetPaging();
  }

  async function exportCurrent() {
    refresh();
    if (!view.lastResult) return;
    nodes.exportButton.disabled = true;
    nodes.exportStatus.classList.remove("error");
    nodes.exportStatus.textContent = "Preparando el archivo…";
    try {
      const fileName = await options.onExport(view.lastResult, view.lastRange, view.lastFilters);
      nodes.exportStatus.textContent = "Descargado: " + fileName;
    } catch (error) {
      console.error("No fue posible generar el Excel", error);
      nodes.exportStatus.classList.add("error");
      nodes.exportStatus.textContent = "No se pudo generar el archivo. Revisa tu conexión e inténtalo de nuevo.";
    } finally {
      nodes.exportButton.disabled = false;
    }
  }

  populateStaticOptions();
  nodes.form.addEventListener("submit", (event) => event.preventDefault());
  nodes.form.addEventListener("change", resetPaging);
  nodes.nameInput.addEventListener("input", resetPaging);
  nodes.showEmptyGroups.addEventListener("change", refresh);
  nodes.moreButton.addEventListener("click", () => {
    view.visibleCount += PAGE_SIZE;
    refresh();
  });
  nodes.resetButton.addEventListener("click", () => {
    nodes.form.reset();
    nodes.dayInput.value = todayKey();
    nodes.weekInput.value = todayKey();
    resetPaging();
  });
  if (nodes.exportButton && options.onExport) nodes.exportButton.addEventListener("click", exportCurrent);

  return { open, refresh };
}

/* Texto legible de los filtros, usado en el encabezado del Excel. */
export function describeFilters(filters) {
  const parts = [];
  if (filters.group) parts.push(filters.group === NO_GROUP ? NO_GROUP : "Grupo " + filters.group);
  if (filters.franja) parts.push("Franja: " + franjaLabel(filters.franja));
  if (filters.excuse) parts.push("Excusa: " + EXCUSE_FILTER_LABELS[filters.excuse]);
  if (filters.name && filters.name.trim()) parts.push("Nombre contiene: “" + filters.name.trim() + "”");
  return parts.length ? parts.join(" · ") : "Sin filtros adicionales";
}
