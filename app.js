/*
 * Panel web de IERUU.
 * Lee la Realtime Database por REST para que esta beta no necesite autenticación ni SDK.
 * Cuando se implemente Firebase Authentication, las reglas deben dejar de ser públicas.
 */

const DATABASE_URL = "https://ieruu-asistencia-default-rtdb.firebaseio.com";
const REFRESH_INTERVAL_MS = 60_000;

const elements = {
  refreshButton: document.querySelector("#refreshButton"),
  searchInput: document.querySelector("#searchInput"),
  groupSelect: document.querySelector("#groupSelect"),
  syncStatus: document.querySelector("#syncStatus"),
  groupsContainer: document.querySelector("#groupsContainer"),
  studentCount: document.querySelector("#studentCount"),
  lateCount: document.querySelector("#lateCount"),
  lateRecordCount: document.querySelector("#lateRecordCount"),
  emptyStateTemplate: document.querySelector("#emptyStateTemplate")
};

const state = {
  students: {},
  records: {},
  search: "",
  group: ""
};

const groupCollator = new Intl.Collator("es-CO", { numeric: true, sensitivity: "base" });
const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
  year: "numeric"
});

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function element(tagName, className, content) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

async function fetchNode(path) {
  const response = await fetch(`${DATABASE_URL}/${path}.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Firebase respondió con HTTP ${response.status}.`);
  return response.json();
}

async function loadData() {
  elements.refreshButton.disabled = true;
  elements.syncStatus.classList.remove("error");
  elements.syncStatus.textContent = "Actualizando datos…";

  try {
    const [students, records] = await Promise.all([fetchNode("estudiantes"), fetchNode("registros")]);
    state.students = students || {};
    state.records = records || {};
    populateGroupSelect();
    render();
    elements.syncStatus.textContent = `Actualizado a las ${new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}.`;
  } catch (error) {
    console.error("No fue posible cargar el panel de maestros", error);
    elements.syncStatus.classList.add("error");
    elements.syncStatus.textContent = "No fue posible leer Firebase. Verifica Internet y las reglas de Realtime Database.";
    elements.groupsContainer.replaceChildren();
    elements.groupsContainer.append(elements.emptyStateTemplate.content.cloneNode(true));
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function lateRecordsByUid() {
  const index = new Map();

  Object.values(state.records).forEach((record) => {
    if (!record || (record.tarde !== true && record.tarde !== "true")) return;
    const uid = text(record.uid).toUpperCase();
    if (!uid) return;

    const timestamp = Number(record.timestamp) || Date.parse(`${text(record.fecha)}T${text(record.hora)}`) || 0;
    const event = {
      timestamp,
      label: formatLateDate(record)
    };

    if (!index.has(uid)) index.set(uid, []);
    index.get(uid).push(event);
  });

  index.forEach((events) => events.sort((first, second) => second.timestamp - first.timestamp));
  return index;
}

function formatLateDate(record) {
  const storedDate = text(record.fecha);
  const storedTime = text(record.hora);
  const match = storedDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (match) {
    const localDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return `${dateFormatter.format(localDate)}${storedTime ? ` · ${storedTime}` : ""}`;
  }

  if (Number(record.timestamp)) {
    return new Date(Number(record.timestamp)).toLocaleString("es-CO", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
    });
  }

  return storedTime || "Fecha no disponible";
}

function studentRows() {
  const recordsByUid = lateRecordsByUid();
  return Object.entries(state.students)
    .filter(([, student]) => student && typeof student === "object")
    .map(([uid, student]) => ({
      uid: uid.toUpperCase(),
      name: text(student.nombre) || "Sin nombre",
      group: text(student.grupo) || "Sin grupo",
      lateTotal: safeNumber(student.llegadasTarde),
      lateDates: recordsByUid.get(uid.toUpperCase()) || []
    }));
}

function populateGroupSelect() {
  const selectedGroup = state.group;
  const groups = [...new Set(studentRows().map((student) => student.group))].sort(groupCollator.compare);
  elements.groupSelect.replaceChildren(new Option("Todos los grupos", ""));
  groups.forEach((group) => elements.groupSelect.add(new Option(`Grupo ${group}`, group)));

  if (groups.includes(selectedGroup)) {
    elements.groupSelect.value = selectedGroup;
  } else {
    state.group = "";
  }
}

function render() {
  const allStudents = studentRows();
  const visibleStudents = allStudents.filter((student) => {
    const matchesSearch = student.name.toLocaleLowerCase("es-CO").includes(state.search);
    const matchesGroup = !state.group || student.group === state.group;
    return matchesSearch && matchesGroup;
  });

  const accumulatedLates = allStudents.reduce((total, student) => total + student.lateTotal, 0);
  const lateEventCount = allStudents.reduce((total, student) => total + student.lateDates.length, 0);
  elements.studentCount.textContent = allStudents.length;
  elements.lateCount.textContent = accumulatedLates;
  elements.lateRecordCount.textContent = lateEventCount;

  const groups = new Map();
  visibleStudents.forEach((student) => {
    if (!groups.has(student.group)) groups.set(student.group, []);
    groups.get(student.group).push(student);
  });

  elements.groupsContainer.replaceChildren();
  if (!groups.size) {
    elements.groupsContainer.append(elements.emptyStateTemplate.content.cloneNode(true));
    return;
  }

  [...groups.entries()]
    .sort(([firstGroup], [secondGroup]) => groupCollator.compare(firstGroup, secondGroup))
    .forEach(([group, students]) => elements.groupsContainer.append(renderGroup(group, students)));
}

function renderGroup(group, students) {
  const section = element("section", "group-section");
  const heading = element("div", "group-heading");
  heading.append(element("h2", "", `Grupo ${group}`));
  heading.append(element("span", "", `${students.length} estudiante${students.length === 1 ? "" : "s"}`));

  const list = element("div", "student-list");
  students
    .sort((first, second) => groupCollator.compare(first.name, second.name))
    .forEach((student) => list.append(renderStudent(student)));

  section.append(heading, list);
  return section;
}

function renderStudent(student) {
  const row = element("article", "student-row");
  const nameColumn = element("div");
  nameColumn.append(element("span", "field-label", "Estudiante"));
  nameColumn.append(element("div", "student-name", student.name));

  const totalColumn = element("div");
  totalColumn.append(element("span", "field-label", "Tardanzas totales"));
  totalColumn.append(element("span", "late-total", student.lateTotal));

  const datesColumn = element("div", "dates");
  datesColumn.append(element("span", "field-label", "Fechas de llegada tarde"));

  if (!student.lateDates.length) {
    datesColumn.append(element("p", "", "Sin llegadas tarde registradas."));
  } else {
    const details = element("details");
    const summary = element("summary", "", `Última: ${student.lateDates[0].label} · Ver todas (${student.lateDates.length})`);
    const list = element("ul", "date-list");
    student.lateDates.forEach((event) => list.append(element("li", "", event.label)));
    details.append(summary, list);
    datesColumn.append(details);
  }

  row.append(nameColumn, totalColumn, datesColumn);
  return row;
}

elements.refreshButton.addEventListener("click", loadData);
elements.searchInput.addEventListener("input", (event) => {
  state.search = text(event.target.value).toLocaleLowerCase("es-CO");
  render();
});
elements.groupSelect.addEventListener("change", (event) => {
  state.group = event.target.value;
  render();
});

loadData();
window.setInterval(loadData, REFRESH_INTERVAL_MS);
