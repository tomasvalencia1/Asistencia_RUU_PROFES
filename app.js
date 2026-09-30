/*
 * Panel de docentes IERUU.
 *
 * La interfaz usa Firebase Authentication para identificar al personal y
 * Realtime Database para recibir cambios en vivo. El rol se consulta en:
 * /usuarios/<uid de Firebase Auth>
 *
 * Los permisos reales no dependen de los botones: database.rules.json los
 * aplica también en Firebase para que un docente no pueda modificar datos
 * desde las herramientas del navegador.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  get,
  getDatabase,
  onValue,
  ref,
  remove,
  set,
  update
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const database = getDatabase(firebaseApp);

const GROUPS = [];
for (let grade = 6; grade <= 11; grade += 1) {
  for (let section = 1; section <= 3; section += 1) {
    GROUPS.push(String(grade) + "." + String(section));
  }
}

const STAFF_ROLES = new Set(["docente", "directivo", "admin"]);
const MANAGER_ROLES = new Set(["directivo", "admin"]);
const ROLE_LABELS = {
  docente: "Docente",
  directivo: "Directivo",
  admin: "Administrador"
};
const EXCUSE_LABELS = {
  pendiente: "Pendiente",
  validada: "Validada",
  rechazada: "Rechazada"
};

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
  year: "numeric"
});
const monthFormatter = new Intl.DateTimeFormat("es-CO", {
  month: "long",
  year: "numeric"
});
const groupCollator = new Intl.Collator("es-CO", {
  numeric: true,
  sensitivity: "base"
});

const elements = {
  loginView: document.querySelector("#loginView"),
  appView: document.querySelector("#appView"),
  loginForm: document.querySelector("#loginForm"),
  emailInput: document.querySelector("#emailInput"),
  passwordInput: document.querySelector("#passwordInput"),
  loginButton: document.querySelector("#loginButton"),
  loginError: document.querySelector("#loginError"),
  logoutButton: document.querySelector("#logoutButton"),
  userName: document.querySelector("#userName"),
  userRole: document.querySelector("#userRole"),
  accessNotice: document.querySelector("#accessNotice"),
  studentCount: document.querySelector("#studentCount"),
  lateCount: document.querySelector("#lateCount"),
  lateRecordCount: document.querySelector("#lateRecordCount"),
  searchInput: document.querySelector("#searchInput"),
  refreshButton: document.querySelector("#refreshButton"),
  addStudentButton: document.querySelector("#addStudentButton"),
  syncStatus: document.querySelector("#syncStatus"),
  dataWarning: document.querySelector("#dataWarning"),
  groupTabs: document.querySelector("#groupTabs"),
  activeGroupTitle: document.querySelector("#activeGroupTitle"),
  activeGroupCount: document.querySelector("#activeGroupCount"),
  studentsContainer: document.querySelector("#studentsContainer"),
  studentDialog: document.querySelector("#studentDialog"),
  studentForm: document.querySelector("#studentForm"),
  studentUidInput: document.querySelector("#studentUidInput"),
  studentNameInput: document.querySelector("#studentNameInput"),
  studentGroupInput: document.querySelector("#studentGroupInput"),
  studentFormError: document.querySelector("#studentFormError"),
  saveStudentButton: document.querySelector("#saveStudentButton"),
  excuseDialog: document.querySelector("#excuseDialog"),
  excuseForm: document.querySelector("#excuseForm"),
  excuseRecordInfo: document.querySelector("#excuseRecordInfo"),
  excuseStatusInput: document.querySelector("#excuseStatusInput"),
  excuseReasonInput: document.querySelector("#excuseReasonInput"),
  excuseFormError: document.querySelector("#excuseFormError"),
  saveExcuseButton: document.querySelector("#saveExcuseButton"),
  deleteExcuseButton: document.querySelector("#deleteExcuseButton")
};

const state = {
  authUser: null,
  profile: null,
  students: {},
  records: {},
  activeGroup: GROUPS[0],
  search: "",
  sessionId: 0,
  studentUnsubscribe: null,
  recordUnsubscribe: null,
  editingRecordId: null
};

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function uidKey(value) {
  return text(value).replace(/[:\s-]/g, "").toUpperCase();
}

function normalizeUid(value) {
  const uid = uidKey(value);
  return /^[0-9A-F]{4,32}$/.test(uid) ? uid : "";
}

function normalizeGroup(value) {
  const raw = text(value).replace(",", ".").replace(/\s+/g, "");
  const withSeparator = raw.match(/^(6|7|8|9|10|11)\.([1-3])$/);
  if (withSeparator) return withSeparator[1] + "." + withSeparator[2];

  const compact = raw.match(/^(6|7|8|9|10|11)([1-3])$/);
  if (compact) return compact[1] + "." + compact[2];

  return "";
}

function createElement(tagName, className, content) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function roleLabel(role) {
  return ROLE_LABELS[role] || "Sin rol";
}

function isActiveStaff(profile) {
  return Boolean(profile) && profile.activo === true && STAFF_ROLES.has(text(profile.rol));
}

function canManage() {
  return isActiveStaff(state.profile) && MANAGER_ROLES.has(text(state.profile.rol));
}

function setStatus(message, isError) {
  elements.syncStatus.textContent = message;
  elements.syncStatus.classList.toggle("error", Boolean(isError));
}

function showLoginError(message) {
  elements.loginError.textContent = message;
  elements.loginError.hidden = !message;
}

function showStudentFormError(message) {
  elements.studentFormError.textContent = message;
  elements.studentFormError.hidden = !message;
}

function showExcuseFormError(message) {
  elements.excuseFormError.textContent = message;
  elements.excuseFormError.hidden = !message;
}

function showLogin() {
  elements.appView.hidden = true;
  elements.loginView.hidden = false;
  elements.passwordInput.value = "";
}

function showApp() {
  elements.loginView.hidden = true;
  elements.appView.hidden = false;
  elements.userName.textContent = text(state.profile.nombre) || text(state.authUser.email) || "Usuario";
  elements.userRole.textContent = roleLabel(text(state.profile.rol));
  elements.addStudentButton.hidden = !canManage();
  elements.accessNotice.textContent = canManage()
    ? "Tu rol permite añadir o quitar estudiantes y revisar, validar o quitar excusas."
    : "Tu rol permite consultar estudiantes, tardanzas y las excusas registradas. No puedes modificarlas.";
}

function detachDatabaseListeners() {
  if (state.studentUnsubscribe) state.studentUnsubscribe();
  if (state.recordUnsubscribe) state.recordUnsubscribe();
  state.studentUnsubscribe = null;
  state.recordUnsubscribe = null;
}

function profileErrorMessage(error) {
  if (error && error.code === "PERMISSION_DENIED") {
    return "Tu cuenta no puede leer su perfil. Revisa usuarios y las reglas de Firebase.";
  }
  return "No se pudo comprobar tu rol. Verifica Internet y la configuración de Firebase.";
}

function loginErrorMessage(error) {
  const code = error && error.code ? error.code : "";
  if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
    return "El correo o la contraseña no son correctos.";
  }
  if (code === "auth/invalid-email") return "Escribe un correo válido.";
  if (code === "auth/too-many-requests") return "Hay demasiados intentos. Espera unos minutos e inténtalo de nuevo.";
  return "No fue posible iniciar sesión. Verifica Internet e inténtalo de nuevo.";
}

function subscribeToData() {
  state.studentUnsubscribe = onValue(
    ref(database, "estudiantes"),
    (snapshot) => {
      state.students = snapshot.val() || {};
      render();
      setStatus("Conexión en vivo · actualizado " + new Date().toLocaleTimeString("es-CO", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }), false);
    },
    () => {
      setStatus("No fue posible leer estudiantes. Revisa tu conexión o las reglas de Firebase.", true);
    }
  );

  state.recordUnsubscribe = onValue(
    ref(database, "registros"),
    (snapshot) => {
      state.records = snapshot.val() || {};
      render();
      setStatus("Conexión en vivo · actualizado " + new Date().toLocaleTimeString("es-CO", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }), false);
    },
    () => {
      setStatus("No fue posible leer tardanzas. Revisa tu conexión o las reglas de Firebase.", true);
    }
  );
}

function recordTimestamp(record) {
  const storedTimestamp = Number(record.timestamp);
  if (Number.isFinite(storedTimestamp) && storedTimestamp > 0) return storedTimestamp;

  const date = text(record.fecha);
  const time = text(record.hora) || "00:00:00";
  const parsed = Date.parse(date + "T" + time);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatExactDate(record) {
  const storedDate = text(record.fecha);
  const storedTime = text(record.hora);
  const dateParts = storedDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (dateParts) {
    const localDate = new Date(
      Number(dateParts[1]),
      Number(dateParts[2]) - 1,
      Number(dateParts[3])
    );
    return dateFormatter.format(localDate) + (storedTime ? " · " + storedTime : "");
  }

  const timestamp = recordTimestamp(record);
  if (timestamp) {
    return new Date(timestamp).toLocaleString("es-CO", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  return storedTime || "Fecha no disponible";
}

function monthKey(record) {
  const match = text(record.fecha).match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (match) return match[1] + "-" + match[2];

  const timestamp = recordTimestamp(record);
  if (!timestamp) return "sin-fecha";
  const date = new Date(timestamp);
  return String(date.getFullYear()) + "-" + String(date.getMonth() + 1).padStart(2, "0");
}

function monthLabel(key) {
  const match = key.match(/^(\d{4})-(\d{2})$/);
  if (!match) return "Fecha sin identificar";

  const result = monthFormatter.format(new Date(Number(match[1]), Number(match[2]) - 1, 1));
  return result.charAt(0).toUpperCase() + result.slice(1);
}

function lateRecordIndex() {
  const index = new Map();

  Object.entries(state.records).forEach(([id, rawRecord]) => {
    if (!rawRecord || (rawRecord.tarde !== true && rawRecord.tarde !== "true")) return;

    const uid = uidKey(rawRecord.uid);
    if (!uid) return;

    const justification = rawRecord.justificacion && typeof rawRecord.justificacion === "object"
      ? rawRecord.justificacion
      : null;
    const event = {
      id,
      record: rawRecord,
      timestamp: recordTimestamp(rawRecord),
      exactDate: formatExactDate(rawRecord),
      month: monthKey(rawRecord),
      justification
    };

    if (!index.has(uid)) index.set(uid, []);
    index.get(uid).push(event);
  });

  index.forEach((events) => {
    events.sort((first, second) => second.timestamp - first.timestamp);
  });
  return index;
}

function studentRows() {
  const lateByUid = lateRecordIndex();
  return Object.entries(state.students)
    .filter((entry) => entry[1] && typeof entry[1] === "object")
    .map(([uid, rawStudent]) => {
      const group = normalizeGroup(rawStudent.grupo);
      const key = uidKey(uid);
      return {
        uid: key || text(uid).toUpperCase(),
        name: text(rawStudent.nombre) || "Sin nombre",
        rawGroup: text(rawStudent.grupo),
        group,
        lateTotal: numberOrZero(rawStudent.llegadasTarde),
        lateEvents: lateByUid.get(key) || []
      };
    });
}

function renderSummary(rows) {
  const totalLates = rows.reduce((total, student) => total + student.lateTotal, 0);
  const totalEvents = rows.reduce((total, student) => total + student.lateEvents.length, 0);
  elements.studentCount.textContent = String(rows.length);
  elements.lateCount.textContent = String(totalLates);
  elements.lateRecordCount.textContent = String(totalEvents);
}

function renderWarning(rows) {
  const invalidGroups = rows.filter((student) => !GROUPS.includes(student.group));
  if (!invalidGroups.length) {
    elements.dataWarning.hidden = true;
    return;
  }

  elements.dataWarning.hidden = false;
  elements.dataWarning.textContent =
    String(invalidGroups.length) +
    " estudiante(s) no aparece(n) en las pestañas porque su grupo no tiene el formato 6.1 a 11.3. Corrige el dato en Firebase.";
}

function renderTabs(rows) {
  const counts = new Map(GROUPS.map((group) => [group, 0]));
  rows.forEach((student) => {
    if (counts.has(student.group)) counts.set(student.group, counts.get(student.group) + 1);
  });

  elements.groupTabs.replaceChildren();
  GROUPS.forEach((group) => {
    const tab = createElement("button", "group-tab");
    tab.type = "button";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(group === state.activeGroup));
    tab.setAttribute("aria-controls", "studentsContainer");
    tab.append(createElement("span", "", group));
    tab.append(createElement("span", "tab-count", String(counts.get(group))));
    tab.addEventListener("click", () => {
      state.activeGroup = group;
      render();
    });
    elements.groupTabs.append(tab);
  });
}

function excusePresentation(justification) {
  if (!justification) {
    return {
      state: "empty",
      label: "Sin excusa",
      detail: "No se ha registrado motivo ni validación."
    };
  }

  const stateName = text(justification.estado);
  return {
    state: EXCUSE_LABELS[stateName] ? stateName : "pendiente",
    label: EXCUSE_LABELS[stateName] || "Pendiente",
    detail: text(justification.motivo) || "Sin motivo escrito."
  };
}

function renderEvents(student) {
  const column = createElement("section", "events-column");
  column.append(createElement("span", "field-label events-heading", "Llegadas tarde por mes"));

  if (!student.lateEvents.length) {
    column.append(createElement("p", "events-empty", "Sin llegadas tarde registradas."));
    return column;
  }

  const months = new Map();
  student.lateEvents.forEach((event) => {
    if (!months.has(event.month)) months.set(event.month, []);
    months.get(event.month).push(event);
  });

  [...months.entries()]
    .sort(([first], [second]) => second.localeCompare(first))
    .forEach(([month, events], index) => {
      const details = createElement("details", "month-block");
      details.open = index === 0;
      const summary = createElement(
        "summary",
        "",
        monthLabel(month) + " · " + String(events.length) + " tardanza" + (events.length === 1 ? "" : "s")
      );
      const list = createElement("div", "month-events");

      events.forEach((event) => {
        const eventRow = createElement("article", "late-event");
        const date = createElement("span", "event-date", event.exactDate);
        const excuse = excusePresentation(event.justification);
        const excuseArea = createElement("div", "event-excuse");
        excuseArea.append(createElement("span", "state-pill state-" + excuse.state, excuse.label));
        excuseArea.append(createElement("p", "", excuse.detail));
        eventRow.append(date, excuseArea);

        if (canManage()) {
          const reviewButton = createElement("button", "small-button", event.justification ? "Editar excusa" : "Validar excusa");
          reviewButton.type = "button";
          reviewButton.addEventListener("click", () => openExcuseDialog(event, student));
          eventRow.append(reviewButton);
        }

        list.append(eventRow);
      });

      details.append(summary, list);
      column.append(details);
    });

  return column;
}

function renderStudent(student) {
  const card = createElement("article", "student-card");

  const identity = createElement("div", "identity-column");
  identity.append(createElement("h3", "student-name", student.name));
  identity.append(createElement("p", "uid-text", "UID: " + student.uid));
  if (canManage()) {
    const actions = createElement("div", "student-actions");
    const removeButton = createElement("button", "small-button danger", "Quitar estudiante");
    removeButton.type = "button";
    removeButton.addEventListener("click", () => removeStudent(student));
    actions.append(removeButton);
    identity.append(actions);
  }

  const totals = createElement("div", "totals-column");
  totals.append(createElement("span", "field-label", "Tardanzas totales"));
  totals.append(createElement("span", "late-total", String(student.lateTotal)));

  card.append(identity, totals, renderEvents(student));
  return card;
}

function renderGroup(rows) {
  const groupMembers = rows
    .filter((student) => student.group === state.activeGroup)
    .sort((first, second) => groupCollator.compare(first.name, second.name));
  const search = state.search.toLocaleLowerCase("es-CO");
  const visibleMembers = groupMembers.filter((student) => {
    return !search ||
      student.name.toLocaleLowerCase("es-CO").includes(search) ||
      student.uid.toLocaleLowerCase("es-CO").includes(search);
  });

  elements.activeGroupTitle.textContent = "Grupo " + state.activeGroup;
  elements.activeGroupCount.textContent =
    String(groupMembers.length) + " estudiante" + (groupMembers.length === 1 ? "" : "s");
  elements.studentsContainer.replaceChildren();

  if (!visibleMembers.length) {
    const empty = createElement("section", "empty-state");
    empty.append(createElement("h3", "", search ? "No hay coincidencias" : "Aún no hay estudiantes en este grupo"));
    empty.append(createElement(
      "p",
      "",
      search
        ? "Prueba con otro nombre o UID."
        : canManage()
          ? "Usa “Añadir estudiante” para registrar el primer estudiante de este grupo."
          : "Cuando administración registre estudiantes, aparecerán aquí automáticamente."
    ));
    elements.studentsContainer.append(empty);
    return;
  }

  visibleMembers.forEach((student) => elements.studentsContainer.append(renderStudent(student)));
}

function render() {
  const rows = studentRows();
  renderSummary(rows);
  renderWarning(rows);
  renderTabs(rows);
  renderGroup(rows);
}

function populateStudentGroups() {
  elements.studentGroupInput.replaceChildren();
  GROUPS.forEach((group) => {
    elements.studentGroupInput.append(new Option("Grupo " + group, group));
  });
}

function openDialog(dialog) {
  if (typeof dialog.showModal === "function") dialog.showModal();
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}

function openStudentDialog() {
  if (!canManage()) return;
  elements.studentForm.reset();
  showStudentFormError("");
  elements.studentGroupInput.value = state.activeGroup;
  openDialog(elements.studentDialog);
  elements.studentUidInput.focus();
}

function openExcuseDialog(event, student) {
  if (!canManage()) return;

  state.editingRecordId = event.id;
  const justification = event.justification || {};
  elements.excuseRecordInfo.textContent =
    student.name + " · Grupo " + student.group + " · " + event.exactDate;
  elements.excuseStatusInput.value = EXCUSE_LABELS[text(justification.estado)]
    ? text(justification.estado)
    : "pendiente";
  elements.excuseReasonInput.value = text(justification.motivo);
  elements.deleteExcuseButton.hidden = !event.justification;
  showExcuseFormError("");
  openDialog(elements.excuseDialog);
  elements.excuseReasonInput.focus();
}

async function refreshData() {
  if (!state.authUser) return;
  elements.refreshButton.disabled = true;
  setStatus("Actualizando datos…", false);
  try {
    const results = await Promise.all([
      get(ref(database, "estudiantes")),
      get(ref(database, "registros"))
    ]);
    state.students = results[0].val() || {};
    state.records = results[1].val() || {};
    render();
    setStatus("Actualizado manualmente.", false);
  } catch (error) {
    console.error("No fue posible actualizar el panel", error);
    setStatus("No fue posible actualizar. Revisa tu conexión o las reglas de Firebase.", true);
  } finally {
    elements.refreshButton.disabled = false;
  }
}

async function removeStudent(student) {
  if (!canManage()) return;
  const confirmed = window.confirm(
    "¿Quitar a " + student.name + " del grupo " + student.group +
    "? Sus registros históricos de tardanza se conservarán."
  );
  if (!confirmed) return;

  try {
    await remove(ref(database, "estudiantes/" + student.uid));
    setStatus("Estudiante retirado. Sus registros históricos se conservaron.", false);
  } catch (error) {
    console.error("No fue posible quitar estudiante", error);
    setStatus("No fue posible quitar el estudiante. Verifica que tu rol sea Directivo o Administrador.", true);
  }
}

async function saveStudent(event) {
  event.preventDefault();
  if (!canManage()) return;

  const uid = normalizeUid(elements.studentUidInput.value);
  const name = text(elements.studentNameInput.value);
  const group = normalizeGroup(elements.studentGroupInput.value);

  if (!uid) {
    showStudentFormError("El UID debe contener entre 4 y 32 caracteres hexadecimales. No uses espacios, dos puntos ni guiones.");
    return;
  }
  if (!name) {
    showStudentFormError("Escribe el nombre del estudiante.");
    return;
  }
  if (!GROUPS.includes(group)) {
    showStudentFormError("Selecciona uno de los grupos de 6.1 a 11.3.");
    return;
  }

  elements.saveStudentButton.disabled = true;
  showStudentFormError("");
  try {
    await set(ref(database, "estudiantes/" + uid), {
      nombre: name,
      grupo: group,
      llegadasTarde: 0
    });
    state.activeGroup = group;
    closeDialog(elements.studentDialog);
    setStatus("Estudiante añadido en el grupo " + group + ".", false);
  } catch (error) {
    console.error("No fue posible guardar estudiante", error);
    showStudentFormError(
      "No se pudo guardar. Puede que ese UID ya exista o que tu rol no tenga permiso."
    );
  } finally {
    elements.saveStudentButton.disabled = false;
  }
}

async function saveExcuse(event) {
  event.preventDefault();
  if (!canManage() || !state.editingRecordId) return;

  const status = text(elements.excuseStatusInput.value);
  const reason = text(elements.excuseReasonInput.value);
  if (!EXCUSE_LABELS[status]) {
    showExcuseFormError("Selecciona un estado válido.");
    return;
  }
  if (!reason) {
    showExcuseFormError("Escribe el motivo o la explicación de la tardanza.");
    return;
  }

  elements.saveExcuseButton.disabled = true;
  showExcuseFormError("");
  try {
    await update(ref(database, "registros/" + state.editingRecordId), {
      justificacion: {
        estado: status,
        motivo: reason,
        revisadaPorUid: state.authUser.uid,
        revisadaEn: Date.now()
      }
    });
    closeDialog(elements.excuseDialog);
    setStatus("Excusa actualizada.", false);
  } catch (error) {
    console.error("No fue posible guardar excusa", error);
    showExcuseFormError("No se pudo guardar la revisión. Verifica que tu rol sea Directivo o Administrador.");
  } finally {
    elements.saveExcuseButton.disabled = false;
  }
}

async function deleteExcuse() {
  if (!canManage() || !state.editingRecordId) return;
  if (!window.confirm("¿Quitar esta excusa y su motivo?")) return;

  elements.deleteExcuseButton.disabled = true;
  try {
    await remove(ref(database, "registros/" + state.editingRecordId + "/justificacion"));
    closeDialog(elements.excuseDialog);
    setStatus("Excusa retirada.", false);
  } catch (error) {
    console.error("No fue posible quitar excusa", error);
    showExcuseFormError("No se pudo quitar la excusa. Inténtalo de nuevo.");
  } finally {
    elements.deleteExcuseButton.disabled = false;
  }
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showLoginError("");
  elements.loginButton.disabled = true;
  try {
    await signInWithEmailAndPassword(
      auth,
      text(elements.emailInput.value),
      elements.passwordInput.value
    );
  } catch (error) {
    console.error("No fue posible iniciar sesión", error);
    showLoginError(loginErrorMessage(error));
  } finally {
    elements.loginButton.disabled = false;
  }
});

elements.logoutButton.addEventListener("click", async () => {
  try {
    await signOut(auth);
  } catch (error) {
    console.error("No fue posible cerrar sesión", error);
  }
});

elements.searchInput.addEventListener("input", (event) => {
  state.search = text(event.target.value);
  render();
});
elements.refreshButton.addEventListener("click", refreshData);
elements.addStudentButton.addEventListener("click", openStudentDialog);
elements.studentForm.addEventListener("submit", saveStudent);
elements.excuseForm.addEventListener("submit", saveExcuse);
elements.deleteExcuseButton.addEventListener("click", deleteExcuse);
document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => {
    const dialog = document.querySelector("#" + button.dataset.closeDialog);
    if (dialog) closeDialog(dialog);
  });
});

populateStudentGroups();
render();

onAuthStateChanged(auth, async (user) => {
  const sessionId = state.sessionId + 1;
  state.sessionId = sessionId;
  detachDatabaseListeners();
  state.students = {};
  state.records = {};
  state.authUser = null;
  state.profile = null;
  state.editingRecordId = null;

  if (!user) {
    showLogin();
    return;
  }

  showLoginError("");
  elements.loginButton.disabled = true;
  try {
    const profileSnapshot = await get(ref(database, "usuarios/" + user.uid));
    if (sessionId !== state.sessionId) return;

    const profile = profileSnapshot.val();
    if (!isActiveStaff(profile)) {
      showLoginError(
        "Tu cuenta no tiene un perfil activo con rol docente, directivo o administrador. Pide a administración que la habilite."
      );
      await signOut(auth);
      return;
    }

    state.authUser = user;
    state.profile = profile;
    showApp();
    render();
    setStatus("Conectando actualizaciones en vivo…", false);
    subscribeToData();
  } catch (error) {
    if (sessionId !== state.sessionId) return;
    console.error("No fue posible cargar el perfil del usuario", error);
    showLoginError(profileErrorMessage(error));
    await signOut(auth);
  } finally {
    if (sessionId === state.sessionId) elements.loginButton.disabled = false;
  }
});
