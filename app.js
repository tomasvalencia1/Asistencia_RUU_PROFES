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
 *
 * Organización de la pantalla (pensada para el docente):
 * 1. Elegir un grupo (se recuerda en este navegador).
 * 2. "Hoy": quién llegó tarde y quién no ha llegado (faltas).
 * 3. Lista de estudiantes; al tocar un nombre se ven sus llegadas tarde y excusas.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  browserSessionPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  endBefore,
  get,
  getDatabase,
  limitToFirst,
  onValue,
  orderByChild,
  query,
  ref,
  remove,
  serverTimestamp,
  set,
  startAt,
  update
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js";
import { firebaseConfig } from "./firebase-config.js";
import {
  addDays,
  bogotaParts,
  dayNumber,
  formatDayLong,
  formatMonth,
  franjaLabel,
  isDayKey,
  makeDayKey,
  monthKeyOf,
  normalizeLateEvents,
  shiftMonth,
  todayKey,
  weekdayFromMonday
} from "./query.js";
import { createStatsView } from "./stats.js";
import { exportToXlsx } from "./export-xlsx.js";
import {
  EvidenceError,
  createEvidenceClient,
  createThumbnailLoader,
  evidenceErrorMessage,
  formatBytes,
  prepareImage
} from "./evidence.js";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const database = getDatabase(firebaseApp);
// Las operaciones sobre correos y contraseñas se hacen en el servidor; el navegador no recibe
// nunca privilegios de Firebase Admin ni credenciales de otros usuarios.
const functions = getFunctions(firebaseApp, "us-central1");
const manageUsersCallable = httpsCallable(functions, "manageUsers");
// Fotos de evidencia: siempre a través de la función (ver functions/index.js).
const evidenceClient = createEvidenceClient(httpsCallable(functions, "evidencias", { timeout: 90000 }));
const thumbnailLoader = createThumbnailLoader(evidenceClient);

const GRADES = [
  { grade: 6, label: "Sexto" },
  { grade: 7, label: "Séptimo" },
  { grade: 8, label: "Octavo" },
  { grade: 9, label: "Noveno" },
  { grade: 10, label: "Décimo" },
  { grade: 11, label: "Undécimo" }
];
const GROUPS = [];
GRADES.forEach(({ grade }) => {
  for (let section = 1; section <= 3; section += 1) {
    GROUPS.push(String(grade) + "." + String(section));
  }
});

const STAFF_ROLES = new Set(["docente", "directivo", "admin"]);
const MANAGER_ROLES = new Set(["directivo", "admin"]);
const ROLE_LABELS = {
  docente: "Docente",
  directivo: "Directivo",
  admin: "Administrador",
  lector: "Lector (portería)"
};
const EXCUSE_LABELS = {
  pendiente: "Pendiente",
  validada: "Validada",
  rechazada: "Rechazada"
};
const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MONTH_NAMES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
// Con hasta este número de resultados, la búsqueda abre directamente el detalle de cada estudiante.
const SEARCH_AUTO_EXPAND = 3;
const GROUP_STORAGE_KEY = "ieruu.grupo";

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
  adminUsersButton: document.querySelector("#adminUsersButton"),
  userName: document.querySelector("#userName"),
  userRole: document.querySelector("#userRole"),
  searchInput: document.querySelector("#searchInput"),
  statsButton: document.querySelector("#statsButton"),
  statsDialog: document.querySelector("#statsDialog"),
  syncStatus: document.querySelector("#syncStatus"),
  dataWarning: document.querySelector("#dataWarning"),
  oldYearsNotice: document.querySelector("#oldYearsNotice"),
  oldYearsText: document.querySelector("#oldYearsText"),
  deleteOldYearsButton: document.querySelector("#deleteOldYearsButton"),
  deleteOldYearsDialog: document.querySelector("#deleteOldYearsDialog"),
  deleteOldYearsStep: document.querySelector("#deleteOldYearsStep"),
  deleteOldYearsWarning: document.querySelector("#deleteOldYearsWarning"),
  deleteOldYearsConfirm: document.querySelector("#deleteOldYearsConfirm"),
  groupPicker: document.querySelector("#groupPicker"),
  groupPanel: document.querySelector("#groupPanel"),
  activeGroupLabel: document.querySelector("#activeGroupLabel"),
  activeGroupTitle: document.querySelector("#activeGroupTitle"),
  activeGroupCount: document.querySelector("#activeGroupCount"),
  groupReportButton: document.querySelector("#groupReportButton"),
  addStudentButton: document.querySelector("#addStudentButton"),
  todaySection: document.querySelector("#todaySection"),
  todayTitle: document.querySelector("#todayTitle"),
  todayLateList: document.querySelector("#todayLateList"),
  todayLateCount: document.querySelector("#todayLateCount"),
  todayOffNotice: document.querySelector("#todayOffNotice"),
  todayGrid: document.querySelector("#todayGrid"),
  calendarButton: document.querySelector("#calendarButton"),
  calendarDialog: document.querySelector("#calendarDialog"),
  calendarMonthLabel: document.querySelector("#calendarMonthLabel"),
  calendarPrev: document.querySelector("#calendarPrev"),
  calendarNext: document.querySelector("#calendarNext"),
  calendarGrid: document.querySelector("#calendarGrid"),
  calendarForm: document.querySelector("#calendarForm"),
  calendarFrom: document.querySelector("#calendarFrom"),
  calendarTo: document.querySelector("#calendarTo"),
  calendarReason: document.querySelector("#calendarReason"),
  calendarSummary: document.querySelector("#calendarSummary"),
  calendarError: document.querySelector("#calendarError"),
  calendarClear: document.querySelector("#calendarClear"),
  calendarSave: document.querySelector("#calendarSave"),
  calendarList: document.querySelector("#calendarList"),
  calendarScopeInputs: [...document.querySelectorAll("input[name='calendarScope']")],
  calendarGroups: document.querySelector("#calendarGroups"),
  faltasContainer: document.querySelector("#faltasContainer"),
  faltasCount: document.querySelector("#faltasCount"),
  studentsHeading: document.querySelector("#studentsHeading"),
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
  excuseDialogEyebrow: document.querySelector("#excuseDialogEyebrow"),
  excuseDialogTitle: document.querySelector("#excuseDialogTitle"),
  excuseRecordInfo: document.querySelector("#excuseRecordInfo"),
  excuseStatusInputs: [...document.querySelectorAll("input[name='excuseStatus']")],
  excuseReasonLabel: document.querySelector("#excuseReasonLabel"),
  excuseReasonInput: document.querySelector("#excuseReasonInput"),
  excuseFormError: document.querySelector("#excuseFormError"),
  saveExcuseButton: document.querySelector("#saveExcuseButton"),
  deleteExcuseButton: document.querySelector("#deleteExcuseButton"),
  evidenceSection: document.querySelector("#evidenceSection"),
  faltaRangeSection: document.querySelector("#faltaRangeSection"),
  faltaFromInput: document.querySelector("#faltaFromInput"),
  faltaToInput: document.querySelector("#faltaToInput"),
  faltaRangeSummary: document.querySelector("#faltaRangeSummary"),
  evidenceDropZone: document.querySelector("#evidenceDropZone"),
  evidencePreview: document.querySelector("#evidencePreview"),
  evidenceDropText: document.querySelector("#evidenceDropText"),
  evidenceCameraButton: document.querySelector("#evidenceCameraButton"),
  evidenceFileButton: document.querySelector("#evidenceFileButton"),
  evidenceRetryButton: document.querySelector("#evidenceRetryButton"),
  evidenceRemoveButton: document.querySelector("#evidenceRemoveButton"),
  evidenceStatus: document.querySelector("#evidenceStatus"),
  evidenceCameraInput: document.querySelector("#evidenceCameraInput"),
  evidenceFileInput: document.querySelector("#evidenceFileInput"),
  evidenceViewer: document.querySelector("#evidenceViewer"),
  evidenceViewerTitle: document.querySelector("#evidenceViewerTitle"),
  evidenceViewerImage: document.querySelector("#evidenceViewerImage"),
  evidenceViewerStatus: document.querySelector("#evidenceViewerStatus"),
  evidenceViewerRetry: document.querySelector("#evidenceViewerRetry"),
  userAdminDialog: document.querySelector("#userAdminDialog"),
  userForm: document.querySelector("#userForm"),
  userFormTitle: document.querySelector("#userFormTitle"),
  managedUserNameInput: document.querySelector("#managedUserNameInput"),
  managedUserEmailInput: document.querySelector("#managedUserEmailInput"),
  managedUserRoleInput: document.querySelector("#managedUserRoleInput"),
  managedUserPasswordInput: document.querySelector("#managedUserPasswordInput"),
  managedPasswordLabel: document.querySelector("#managedPasswordLabel"),
  managedUserActiveInput: document.querySelector("#managedUserActiveInput"),
  userFormError: document.querySelector("#userFormError"),
  saveUserButton: document.querySelector("#saveUserButton"),
  cancelUserEditButton: document.querySelector("#cancelUserEditButton"),
  refreshUsersButton: document.querySelector("#refreshUsersButton"),
  managedUsersStatus: document.querySelector("#managedUsersStatus"),
  managedUsersContainer: document.querySelector("#managedUsersContainer")
};

const INACTIVITY_TIMEOUT_MS = 25 * 60 * 1000; // 25 minutos
let inactivityTimer = null;

const state = {
  authUser: null,
  profile: null,
  students: {},
  records: {},
  faltas: {},
  activeGroup: savedGroup(),
  search: "",
  sessionId: 0,
  profileUnsubscribe: null,
  studentUnsubscribe: null,
  recordUnsubscribe: null,
  faltasUnsubscribe: null,
  // Días sin clases (config/diasSinClases): no se cuentan llegadas tarde ni faltas.
  noClassPeriods: {},
  noClassUnsubscribe: null,
  calendar: { month: "", start: "", end: "", notice: "" },
  evidence: {},
  evidenceUnsubscribe: null,
  evidenceEditor: null,
  editingRecordId: null,
  editingFalta: null,
  // Qué estudiantes y meses abrió el usuario: se conserva aunque lleguen lecturas nuevas en vivo.
  openStudents: new Map(),
  openMonths: new Map(),
  managedUsers: [],
  editingUserUid: null
};

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

// Permite buscar sin preocuparse por mayúsculas, espacios o tildes.
function searchText(value) {
  return text(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("es-CO");
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

function savedGroup() {
  try {
    const stored = window.localStorage.getItem(GROUP_STORAGE_KEY);
    if (GROUPS.includes(stored)) return stored;
  } catch (error) {
    // Navegación privada o almacenamiento bloqueado: se empieza por el primer grupo.
  }
  return GROUPS[0];
}

function rememberGroup(group) {
  try {
    window.localStorage.setItem(GROUP_STORAGE_KEY, group);
  } catch (error) {
    // No es necesario recordar el grupo para usar el panel.
  }
}

function createElement(tagName, className, content) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function plural(count, singular, pluralForm) {
  return String(count) + " " + (count === 1 ? singular : pluralForm);
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

function isAdmin() {
  return isActiveStaff(state.profile) && text(state.profile.rol) === "admin";
}

function setStatus(message, isError) {
  elements.syncStatus.textContent = message;
  elements.syncStatus.classList.toggle("error", Boolean(isError));
  elements.syncStatus.classList.toggle("live", !isError && message.includes("en vivo"));
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

function showUserFormError(message) {
  elements.userFormError.textContent = message;
  elements.userFormError.hidden = !message;
}

function showLogin() {
  closeDialog(elements.deleteOldYearsDialog);
  closeDialog(elements.userAdminDialog);
  closeDialog(elements.statsDialog);
  closeDialog(elements.calendarDialog);
  closeDialog(elements.excuseDialog);
  closeDialog(elements.studentDialog);
  closeDialog(elements.evidenceViewer);
  elements.appView.hidden = true;
  elements.loginView.hidden = false;
  elements.passwordInput.value = "";
}

function showApp() {
  elements.loginView.hidden = true;
  elements.appView.hidden = false;
  elements.loginForm.reset();
  elements.userName.textContent = text(state.profile.nombre) || text(state.authUser.email) || "Usuario";
  elements.userRole.textContent = roleLabel(text(state.profile.rol));
  elements.addStudentButton.hidden = !canManage();
  elements.adminUsersButton.hidden = !isAdmin();
  elements.oldYearsNotice.hidden = true;
  if (canManage()) checkOldYears();
}

function detachDatabaseListeners() {
  if (state.profileUnsubscribe) state.profileUnsubscribe();
  state.profileUnsubscribe = null;
  if (state.studentUnsubscribe) state.studentUnsubscribe();
  if (state.recordUnsubscribe) state.recordUnsubscribe();
  if (state.evidenceUnsubscribe) state.evidenceUnsubscribe();
  if (state.faltasUnsubscribe) state.faltasUnsubscribe();
  if (state.noClassUnsubscribe) state.noClassUnsubscribe();
  state.studentUnsubscribe = null;
  state.recordUnsubscribe = null;
  state.evidenceUnsubscribe = null;
  state.faltasUnsubscribe = null;
  state.noClassUnsubscribe = null;
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

function liveStatus() {
  setStatus("Conexión en vivo · actualizado " + new Date().toLocaleTimeString("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }), false);
}

// El perfil se sigue en vivo: si administración desactiva la cuenta o le quita el rol con el
// panel abierto, se cierra la sesión (y se borran los datos cargados); si le cambia el rol, se aplica.
function watchProfile(uid) {
  state.profileUnsubscribe = onValue(
    ref(database, "usuarios/" + uid),
    (snapshot) => {
      const profile = snapshot.val();
      if (!isActiveStaff(profile)) {
        showLoginError("Tu cuenta fue desactivada o ya no tiene rol en el panel. Pide a administración que la habilite.");
        signOut(auth).catch((error) => console.warn("No se pudo cerrar la sesión", error));
        return;
      }
      if (text(profile.rol) === text(state.profile.rol) && text(profile.nombre) === text(state.profile.nombre)) return;
      state.profile = profile;
      showApp();
      render();
    },
    (error) => {
      console.warn("No fue posible seguir el perfil del usuario", error);
    }
  );
}

function subscribeToData() {
  state.studentUnsubscribe = onValue(
    ref(database, "estudiantes"),
    (snapshot) => {
      state.students = snapshot.val() || {};
      render();
      liveStatus();
    },
    () => {
      setStatus("No fue posible leer estudiantes. Revisa tu conexión o las reglas de Firebase.", true);
    }
  );

  // Sólo las lecturas del año en curso: las de años anteriores siguen en Firebase hasta que
  // un directivo o administrador las borre (ver checkOldYears).
  state.recordUnsubscribe = onValue(
    query(ref(database, "registros"), orderByChild("fecha"), startAt(currentYearStart())),
    (snapshot) => {
      state.records = snapshot.val() || {};
      render();
      liveStatus();
    },
    () => {
      setStatus("No fue posible leer las llegadas tarde. Revisa tu conexión o las reglas de Firebase.", true);
    }
  );

  // Sólo metadatos (versión, tamaño, quién subió). Las imágenes se piden a la función.
  state.evidenceUnsubscribe = onValue(
    ref(database, "evidencias"),
    (snapshot) => {
      state.evidence = snapshot.val() || {};
      render();
      if (state.evidenceEditor && !state.evidenceEditor.busy) renderEvidenceEditor();
    },
    (error) => {
      // Ocurre si aún no se publicaron las reglas nuevas: el panel sigue funcionando sin fotos.
      console.warn("No fue posible leer los metadatos de evidencias", error);
      state.evidence = {};
    }
  );

  // Excusas de faltas (inasistencias). Si el nodo no existe aún, no bloquea el panel.
  state.faltasUnsubscribe = onValue(
    ref(database, "faltas"),
    (snapshot) => {
      state.faltas = snapshot.val() || {};
      render();
    },
    (error) => {
      console.warn("No fue posible leer las faltas", error);
      state.faltas = {};
    }
  );

  state.noClassUnsubscribe = onValue(
    ref(database, "config/diasSinClases"),
    (snapshot) => {
      state.noClassPeriods = snapshot.val() || {};
      render();
      if (elements.calendarDialog.open) renderCalendar();
    },
    (error) => {
      console.warn("No fue posible leer los días sin clases", error);
      state.noClassPeriods = {};
    }
  );
}

/* ---------- Lecturas de años anteriores ---------- */

function currentYearStart() {
  return todayKey().slice(0, 4) + "-01-01";
}

// Lecturas con fecha válida de años anteriores (las reglas sólo permiten borrar éstas).
function oldYearsQuery(onlyFirst) {
  const constraints = [orderByChild("fecha"), startAt("2000-01-01"), endBefore(currentYearStart())];
  if (onlyFirst) constraints.push(limitToFirst(1));
  return query(ref(database, "registros"), ...constraints);
}

function showOldYearsText(message) {
  elements.oldYearsText.textContent = message ||
    "Hay lecturas de años anteriores a " + currentYearStart().slice(0, 4) +
    " guardadas en Firebase. El panel ya no las muestra; puedes borrarlas cuando quieras.";
}

// Sólo para directivo y admin: avisa si quedan lecturas de años anteriores (descarga una sola).
async function checkOldYears() {
  const sessionId = state.sessionId;
  try {
    const snapshot = await get(oldYearsQuery(true));
    if (sessionId !== state.sessionId || !canManage()) return;
    showOldYearsText("");
    elements.deleteOldYearsButton.hidden = false;
    elements.deleteOldYearsButton.disabled = false;
    elements.oldYearsNotice.hidden = !snapshot.exists();
  } catch (error) {
    console.warn("No fue posible revisar las lecturas de años anteriores", error);
  }
}

// Un paso de la confirmación: muestra la advertencia y el botón sólo se activa tras unos segundos
// para que se alcance a leer. Devuelve true si se confirmó; false si se canceló o se cerró.
const DELETE_WAIT_SECONDS = 5;

function confirmDeleteStep(step, warning, actionLabel) {
  const dialog = elements.deleteOldYearsDialog;
  const button = elements.deleteOldYearsConfirm;
  elements.deleteOldYearsStep.textContent = "Paso " + step + " de 2";
  elements.deleteOldYearsWarning.textContent = warning;
  return new Promise((resolve) => {
    let remaining = DELETE_WAIT_SECONDS;
    let done = false;
    const showCountdown = () => {
      button.disabled = remaining > 0;
      button.textContent = remaining > 0 ? actionLabel + " (" + remaining + ")" : actionLabel;
    };
    const timer = setInterval(() => {
      remaining -= 1;
      showCountdown();
      if (remaining <= 0) clearInterval(timer);
    }, 1000);
    // Se resuelve desde los botones (y Escape o un cierre externo); no depende sólo del evento "close".
    const finish = (confirmed) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      button.removeEventListener("click", onConfirm);
      dialog.removeEventListener("click", onCancelClick);
      dialog.removeEventListener("cancel", onEscape);
      dialog.removeEventListener("close", onClosed);
      closeDialog(dialog);
      resolve(confirmed);
    };
    const onConfirm = () => {
      if (remaining <= 0) finish(true);
    };
    const onCancelClick = (event) => {
      if (event.target.closest("[data-close-dialog]")) finish(false);
    };
    const onEscape = () => finish(false);
    // El "close" del paso anterior puede llegar cuando este paso ya abrió el diálogo: se ignora.
    const onClosed = () => {
      if (!dialog.open) finish(false);
    };
    button.addEventListener("click", onConfirm);
    dialog.addEventListener("click", onCancelClick);
    dialog.addEventListener("cancel", onEscape);
    dialog.addEventListener("close", onClosed);
    showCountdown();
    openDialog(dialog);
  });
}

async function deleteOldYears() {
  if (!canManage()) return;
  const sessionId = state.sessionId;
  const year = currentYearStart().slice(0, 4);
  elements.deleteOldYearsButton.disabled = true;
  try {
    showOldYearsText("Contando las lecturas de años anteriores…");
    const snapshot = await get(oldYearsQuery(false));
    if (sessionId !== state.sessionId) return;
    const ids = Object.keys(snapshot.val() || {});
    if (!ids.length) {
      elements.oldYearsNotice.hidden = true;
      return;
    }
    const total = plural(ids.length, "lectura", "lecturas");
    showOldYearsText("");
    const firstOk = await confirmDeleteStep(
      1,
      "Vas a borrar " + total + " de antes de " + year + ", con sus excusas. Desaparecerán de Firebase y no " +
        "se pueden recuperar. Si hay que conservarlas, pide antes al administrador que exporte una copia " +
        "desde la consola de Firebase.",
      "Entiendo, continuar"
    );
    if (!firstOk || sessionId !== state.sessionId) return;
    const secondOk = await confirmDeleteStep(
      2,
      "Última confirmación: se borrarán definitivamente " + total + " de antes de " + year +
        ". Esta acción no se puede deshacer.",
      "Borrar definitivamente"
    );
    if (!secondOk || sessionId !== state.sessionId || !canManage()) return;
    const BATCH = 500;
    for (let start = 0; start < ids.length; start += BATCH) {
      const changes = {};
      ids.slice(start, start + BATCH).forEach((id) => {
        changes["registros/" + id] = null;
      });
      await update(ref(database), changes);
      if (sessionId !== state.sessionId) return;
      showOldYearsText("Borrando… " + Math.min(start + BATCH, ids.length) + " de " + ids.length);
    }
    showOldYearsText("Listo: se borraron " + plural(ids.length, "lectura", "lecturas") + " de años anteriores.");
    elements.deleteOldYearsButton.hidden = true;
  } catch (error) {
    if (sessionId !== state.sessionId) return;
    console.error("No fue posible borrar las lecturas de años anteriores", error);
    showOldYearsText("No se pudieron borrar todas las lecturas de años anteriores. Revisa Internet y vuelve a intentarlo.");
  } finally {
    elements.deleteOldYearsButton.disabled = false;
  }
}

/* ---------- Días sin clases ---------- */

// "todos" (o vacío, en periodos antiguos) = todos los grupos; si no, lista "6.1,7.2".
function parseNoClassGroups(value) {
  const raw = text(value);
  if (!raw || raw === "todos") return null;
  const groups = [...new Set(raw.split(",").map(normalizeGroup).filter(Boolean))];
  return groups.length ? groups.sort(groupCollator.compare) : null;
}

// Se calcula una vez por cada dato nuevo de Firebase (state.noClassPeriods se reemplaza, nunca se
// modifica): el panel la consulta por cada llegada tarde.
let noClassCache = { source: null, list: [] };

// Periodos válidos ordenados por fecha: { id, desde, hasta, motivo, groups } (groups null = todos).
function noClassList() {
  if (noClassCache.source === state.noClassPeriods) return noClassCache.list;
  const list = Object.entries(state.noClassPeriods || {})
    .map(([id, period]) => ({
      id,
      desde: text(period && period.desde),
      hasta: text(period && period.hasta),
      motivo: text(period && period.motivo) || "Sin clases",
      groups: parseNoClassGroups(period && period.grupos)
    }))
    .filter((period) => isDayKey(period.desde) && isDayKey(period.hasta) && period.hasta >= period.desde)
    .sort((first, second) => first.desde.localeCompare(second.desde));
  noClassCache = { source: state.noClassPeriods, list };
  return list;
}

function noClassPeriodsOn(day) {
  return noClassList().filter((period) => day >= period.desde && day <= period.hasta);
}

// El periodo sin clases de ese día que afecta a ese grupo, o null. Sin grupo sólo cuentan los de todos.
function noClassPeriodFor(day, group) {
  if (!day) return null;
  const target = normalizeGroup(group);
  return noClassPeriodsOn(day).find((period) => !period.groups || (target && period.groups.includes(target))) || null;
}

// "Todos los grupos", "Grupo 6.1" o "Grupos: Sexto completo, 7.2".
function groupsLabel(groups) {
  if (!groups) return "Todos los grupos";
  if (groups.length === 1) return "Grupo " + groups[0];
  const parts = [];
  GRADES.forEach(({ grade, label }) => {
    const own = [1, 2, 3].map((section) => grade + "." + section).filter((group) => groups.includes(group));
    if (own.length === 3) parts.push(label + " completo");
    else parts.push(...own);
  });
  return "Grupos: " + parts.join(", ");
}

function buildCalendarGroupPicker() {
  elements.calendarGroups.replaceChildren();
  GRADES.forEach(({ grade, label }) => {
    const row = createElement("div", "calendar-grade");
    const all = createElement("label", "check-chip grade-all");
    const allInput = createElement("input");
    allInput.type = "checkbox";
    allInput.dataset.grade = String(grade);
    allInput.setAttribute("aria-label", "Todo " + label);
    all.append(allInput, createElement("span", "", label));
    row.append(all);
    for (let section = 1; section <= 3; section += 1) {
      const group = grade + "." + section;
      const chip = createElement("label", "check-chip");
      const input = createElement("input");
      input.type = "checkbox";
      input.value = group;
      input.dataset.gradeOf = String(grade);
      chip.append(input, createElement("span", "", group));
      row.append(chip);
    }
    elements.calendarGroups.append(row);
  });
  elements.calendarGroups.addEventListener("change", (event) => {
    const input = event.target;
    if (input.dataset.grade) {
      elements.calendarGroups.querySelectorAll("input[data-grade-of='" + input.dataset.grade + "']")
        .forEach((box) => { box.checked = input.checked; });
    }
    syncGradeChecks();
    showCalendarError("");
  });
}

function syncGradeChecks() {
  elements.calendarGroups.querySelectorAll("input[data-grade]").forEach((gradeBox) => {
    const boxes = [...elements.calendarGroups.querySelectorAll("input[data-grade-of='" + gradeBox.dataset.grade + "']")];
    const checked = boxes.filter((box) => box.checked).length;
    gradeBox.checked = checked === boxes.length;
    gradeBox.indeterminate = checked > 0 && checked < boxes.length;
  });
}

function calendarScope() {
  const checked = elements.calendarScopeInputs.find((input) => input.checked);
  return checked ? checked.value : "todos";
}

function selectedCalendarGroups() {
  return [...elements.calendarGroups.querySelectorAll("input[data-grade-of]:checked")].map((input) => input.value);
}

function resetCalendarGroups() {
  elements.calendarScopeInputs.forEach((input) => { input.checked = input.value === "todos"; });
  elements.calendarGroups.querySelectorAll("input").forEach((input) => {
    input.checked = false;
    input.indeterminate = false;
  });
  elements.calendarGroups.hidden = true;
}

function dayCount(desde, hasta) {
  return dayNumber(hasta) - dayNumber(desde) + 1;
}

// "Del lun 12 al vie 16 de oct de 2026", "Del lun 28 de sep al vie 2 de oct de 2026" o "jue 1 de oct de 2026".
function periodLabel(period) {
  const year = (day) => day.slice(0, 4);
  if (period.desde === period.hasta) return shortDayLabel(period.desde) + " de " + year(period.desde);
  const sameYear = year(period.desde) === year(period.hasta);
  const sameMonth = sameYear && monthKeyOf(period.desde) === monthKeyOf(period.hasta);
  const start = sameMonth
    ? shortDayLabel(period.desde).replace(/ de [a-z]+$/, "")
    : shortDayLabel(period.desde) + (sameYear ? "" : " de " + year(period.desde));
  return "Del " + start + " al " + shortDayLabel(period.hasta) + " de " + year(period.hasta);
}

function showCalendarError(message) {
  elements.calendarError.textContent = message;
  elements.calendarError.hidden = !message;
}

function openCalendar() {
  if (!state.calendar.month) state.calendar.month = monthKeyOf(todayKey());
  showCalendarError("");
  renderCalendar();
  openDialog(elements.calendarDialog);
}

function moveCalendar(amount) {
  state.calendar.month = shiftMonth(state.calendar.month || monthKeyOf(todayKey()), amount);
  renderCalendar();
}

// Primer toque: inicio del rango. Segundo toque: fin (en cualquier orden). Un tercero empieza de nuevo.
function selectCalendarDay(day) {
  if (!canManage()) return;
  const calendar = state.calendar;
  if (!calendar.start || calendar.end) {
    calendar.start = day;
    calendar.end = "";
  } else if (day < calendar.start) {
    calendar.end = calendar.start;
    calendar.start = day;
  } else {
    calendar.end = day;
  }
  calendar.notice = "";
  showCalendarError("");
  renderCalendar();
  const again = [...elements.calendarGrid.children].find((cell) => cell.dataset.day === day);
  if (again) again.focus();
}

function renderCalendar() {
  const calendar = state.calendar;
  const month = calendar.month || monthKeyOf(todayKey());
  const today = todayKey();
  const manager = canManage();
  const from = calendar.start;
  const to = calendar.end || calendar.start;

  elements.calendarForm.hidden = !manager;
  elements.calendarMonthLabel.textContent = formatMonth(month);
  elements.calendarGrid.replaceChildren();

  const first = month + "-01";
  const gridStart = addDays(first, -weekdayFromMonday(first));
  for (let index = 0; index < 42; index += 1) {
    const day = addDays(gridStart, index);
    // La sexta fila sólo se dibuja si todavía tiene días del mes.
    if (index === 35 && monthKeyOf(day) !== month) break;
    const periods = noClassPeriodsOn(day);
    const offAll = periods.some((period) => !period.groups);
    const selected = Boolean(from) && day >= from && day <= to;
    const cell = createElement(manager ? "button" : "span", "calendar-day", String(Number(day.slice(8))));
    cell.dataset.day = day;
    if (monthKeyOf(day) !== month) cell.classList.add("outside");
    if (weekdayFromMonday(day) >= 5) cell.classList.add("weekend");
    if (day === today) cell.classList.add("today");
    const offText = periods.map((period) => period.motivo + " (" + groupsLabel(period.groups) + ")").join("; ");
    if (periods.length) {
      cell.classList.add(offAll ? "off" : "off-partial");
      cell.title = offText;
    }
    if (selected) cell.classList.add("selected");
    if (selected && day === from) cell.classList.add("range-start");
    if (selected && day === to) cell.classList.add("range-end");
    const label = formatDayLong(day) + (periods.length ? ", sin clases: " + offText : "") + (day === today ? ", hoy" : "");
    if (manager) {
      cell.type = "button";
      cell.setAttribute("aria-pressed", String(selected));
      cell.setAttribute("aria-label", label);
      cell.addEventListener("click", () => selectCalendarDay(day));
    } else {
      cell.setAttribute("role", "img");
      cell.setAttribute("aria-label", label);
    }
    elements.calendarGrid.append(cell);
  }

  elements.calendarFrom.value = from || "";
  elements.calendarTo.value = from ? to : "";
  if (from) {
    const overlap = noClassList().some((period) => period.desde <= to && period.hasta >= from);
    elements.calendarSummary.textContent = plural(dayCount(from, to), "día elegido", "días elegidos") + ": " +
      periodLabel({ desde: from, hasta: to }) + (overlap ? ". Incluye días que ya estaban marcados." : ".");
  } else {
    elements.calendarSummary.textContent = calendar.notice || "Aún no has elegido días.";
  }
  renderNoClassList();
}

function renderNoClassList() {
  const today = todayKey();
  const list = noClassList();
  elements.calendarList.replaceChildren();
  if (!list.length) {
    elements.calendarList.append(createElement("li", "calendar-empty", "No hay días sin clases registrados."));
    return;
  }
  // Primero los que están en curso o vienen; después los pasados, del más reciente al más antiguo.
  const upcoming = list.filter((period) => period.hasta >= today);
  const past = list.filter((period) => period.hasta < today).reverse();
  [...upcoming, ...past].forEach((period) => {
    const isPast = period.hasta < today;
    const isNow = period.desde <= today && today <= period.hasta;
    const item = createElement("li", "calendar-item" + (isPast ? " past" : "") + (isNow ? " now" : ""));
    const info = createElement("div", "calendar-item-info");
    info.append(createElement("strong", "", period.motivo));
    info.append(createElement(
      "span",
      "",
      periodLabel(period) + " · " + plural(dayCount(period.desde, period.hasta), "día", "días") +
        (isNow ? " · en curso" : isPast ? " · pasado" : "")
    ));
    info.append(createElement("span", "calendar-item-groups" + (period.groups ? "" : " all"), groupsLabel(period.groups)));
    const actions = createElement("div", "calendar-item-actions");
    const show = createElement("button", "small-button", "Ver");
    show.type = "button";
    show.setAttribute("aria-label", "Ver en el calendario: " + period.motivo);
    show.addEventListener("click", () => {
      state.calendar.month = monthKeyOf(period.desde);
      renderCalendar();
    });
    actions.append(show);
    if (canManage()) {
      const removeButton = createElement("button", "small-button danger", "Quitar");
      removeButton.type = "button";
      removeButton.setAttribute("aria-label", "Quitar " + period.motivo + " (" + periodLabel(period) + ")");
      removeButton.addEventListener("click", () => removeNoClassPeriod(period));
      actions.append(removeButton);
    }
    item.append(info, actions);
    elements.calendarList.append(item);
  });
}

async function saveNoClassPeriod(event) {
  event.preventDefault();
  if (!canManage()) return;
  const desde = state.calendar.start;
  const hasta = state.calendar.end || state.calendar.start;
  const motivo = text(elements.calendarReason.value);
  if (!isDayKey(desde) || !isDayKey(hasta)) {
    showCalendarError("Elige en el calendario el primer y el último día.");
    return;
  }
  if (!motivo) {
    showCalendarError("Escribe el motivo, por ejemplo «Vacaciones».");
    elements.calendarReason.focus();
    return;
  }
  if (dayCount(desde, hasta) > 120) {
    showCalendarError("Un periodo puede tener máximo 120 días. Divídelo en partes.");
    return;
  }
  const groups = calendarScope() === "todos" ? null : selectedCalendarGroups();
  if (groups && !groups.length) {
    showCalendarError("Marca los grupos que no tienen clase, o elige «Todos los grupos».");
    return;
  }

  elements.calendarSave.disabled = true;
  showCalendarError("");
  try {
    await set(ref(database, "config/diasSinClases/" + desde + "_" + Date.now().toString(36)), {
      desde,
      hasta,
      motivo,
      grupos: groups ? groups.join(",") : "todos",
      creadoPorUid: state.authUser.uid,
      creadoEn: serverTimestamp()
    });
    state.calendar.start = "";
    state.calendar.end = "";
    state.calendar.notice = "Guardado: " + motivo + " · " + groupsLabel(groups) + " (" + periodLabel({ desde, hasta }) + ").";
    elements.calendarReason.value = "";
    resetCalendarGroups();
    renderCalendar();
  } catch (error) {
    console.error("No fue posible guardar los días sin clases", error);
    showCalendarError("No se pudo guardar. Verifica que tu rol sea Directivo o Administrador y que las reglas de Firebase estén publicadas.");
  } finally {
    elements.calendarSave.disabled = false;
  }
}

async function removeNoClassPeriod(period) {
  if (!canManage()) return;
  const confirmed = window.confirm(
    "¿Quitar «" + period.motivo + "» (" + periodLabel(period) + ")? Esos días volverán a contar llegadas tarde y faltas."
  );
  if (!confirmed) return;
  try {
    await remove(ref(database, "config/diasSinClases/" + period.id));
    showCalendarError("");
  } catch (error) {
    console.error("No fue posible quitar los días sin clases", error);
    showCalendarError("No se pudo quitar. Inténtalo de nuevo.");
  }
}

/* ---------- Fechas (siempre hora de Colombia, igual que el lector y los informes) ---------- */

function recordTimestamp(record) {
  const storedTimestamp = Number(record.timestamp);
  if (Number.isFinite(storedTimestamp) && storedTimestamp > 0) return storedTimestamp;

  const date = text(record.fecha);
  const time = text(record.hora) || "00:00:00";
  const parsed = Date.parse(date + "T" + time + "-05:00");
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordDay(record) {
  const stored = text(record.fecha);
  if (isDayKey(stored)) return stored;
  const timestamp = recordTimestamp(record);
  if (!timestamp) return "";
  const parts = bogotaParts(timestamp);
  return makeDayKey(parts.year, parts.month, parts.day);
}

function recordTime(record) {
  const stored = text(record.hora);
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(stored)) return stored;
  const timestamp = recordTimestamp(record);
  if (!timestamp) return "";
  const parts = bogotaParts(timestamp);
  return String(parts.hour).padStart(2, "0") + ":" + String(parts.minute).padStart(2, "0");
}

// "07:05:30" → "7:05 a. m."
function clockLabel(time) {
  const match = text(time).match(/^(\d{2}):(\d{2})/);
  if (!match) return "";
  const hours = Number(match[1]);
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return String(hour12) + ":" + match[2] + (hours < 12 ? " a. m." : " p. m.");
}

// "2026-10-01" → "jue 1 de oct"
function shortDayLabel(day) {
  const match = text(day).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "Fecha sin identificar";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return WEEKDAYS[date.getUTCDay()] + " " + String(Number(match[3])) + " de " + MONTHS[Number(match[2]) - 1];
}

function monthLabel(key) {
  const match = text(key).match(/^(\d{4})-(\d{2})$/);
  if (!match) return "Fecha sin identificar";
  return MONTH_NAMES[Number(match[2]) - 1] + " de " + match[1];
}

/* ---------- Datos calculados ---------- */

// Una sola pasada por /registros: llegadas tarde por estudiante y quién tiene alguna lectura hoy.
function indexRecords() {
  const today = todayKey();
  const lateByUid = new Map();
  const presentToday = new Set();

  Object.entries(state.records).forEach(([id, rawRecord]) => {
    if (!rawRecord || typeof rawRecord !== "object") return;
    const uid = uidKey(rawRecord.uid);
    if (!uid) return;
    const day = recordDay(rawRecord);
    if (day === today) presentToday.add(uid);
    if (rawRecord.tarde !== true && rawRecord.tarde !== "true") return;
    // En días sin clases (de todos o de su grupo) no se cuentan llegadas tarde.
    const student = state.students[rawRecord.uid] || state.students[uid];
    const recordGroup = normalizeGroup(rawRecord.grupo) || normalizeGroup(student && student.grupo);
    if (noClassPeriodFor(day, recordGroup)) return;

    const justification = rawRecord.justificacion && typeof rawRecord.justificacion === "object"
      ? rawRecord.justificacion
      : null;
    const time = recordTime(rawRecord);
    const event = {
      id,
      record: rawRecord,
      timestamp: recordTimestamp(rawRecord),
      day,
      time,
      month: day ? day.slice(0, 7) : "sin-fecha",
      franja: franjaLabel(rawRecord.periodo),
      exactDate: (day ? shortDayLabel(day) : "Sin fecha") + (time ? " · " + clockLabel(time) : ""),
      justification
    };

    if (!lateByUid.has(uid)) lateByUid.set(uid, []);
    lateByUid.get(uid).push(event);
  });

  lateByUid.forEach((events) => {
    events.sort((first, second) => second.timestamp - first.timestamp);
  });
  return { today, lateByUid, presentToday };
}

function buildModel() {
  const index = indexRecords();
  const currentMonth = index.today.slice(0, 7);
  // No se marcan faltas si nadie ha pasado la tarjeta hoy (fin de semana o muy temprano)
  // ni a los grupos que hoy no tienen clase.
  const readingStarted = index.presentToday.size > 0;
  const rows = Object.entries(state.students)
    .filter((entry) => entry[1] && typeof entry[1] === "object")
    .map(([uid, rawStudent]) => {
      const key = uidKey(uid);
      const lateEvents = index.lateByUid.get(key) || [];
      const studentUid = key || text(uid).toUpperCase();
      const lateToday = lateEvents.filter((event) => event.day === index.today);
      const group = normalizeGroup(rawStudent.grupo);
      const absentToday = readingStarted && !index.presentToday.has(key) && !noClassPeriodFor(index.today, group);
      return {
        uid: studentUid,
        // Clave tal como está en Firebase (puede tener minúsculas o ":" si se creó en la consola).
        firebaseKey: uid,
        name: text(rawStudent.nombre) || "Sin nombre",
        rawGroup: text(rawStudent.grupo),
        group,
        lateEvents,
        lateThisMonth: lateEvents.filter((event) => event.month === currentMonth).length,
        lateToday,
        absentToday,
        faltaExcuse: state.faltas[faltaKey(index.today, studentUid)] || null
      };
    });
  return { today: index.today, readingStarted, rows };
}

/* ---------- Presentación ---------- */

function renderWarning(rows) {
  const invalidGroups = rows.filter((student) => !GROUPS.includes(student.group));
  if (!invalidGroups.length) {
    elements.dataWarning.hidden = true;
    return;
  }

  elements.dataWarning.hidden = false;
  elements.dataWarning.textContent =
    plural(invalidGroups.length, "estudiante no aparece", "estudiantes no aparecen") +
    " en ningún grupo porque su grupo no tiene el formato 6.1 a 11.3. Corrige el dato en Firebase.";
}

function selectGroup(group) {
  state.activeGroup = group;
  rememberGroup(group);
  if (state.search) {
    state.search = "";
    elements.searchInput.value = "";
  }
  render();
  // En el celular el grupo queda debajo de los botones: se lleva la vista hasta él.
  if (window.matchMedia("(max-width: 800px)").matches) {
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    elements.groupPanel.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  }
}

function renderGroupPicker(rows) {
  const counts = new Map(GROUPS.map((group) => [group, 0]));
  rows.forEach((student) => {
    if (counts.has(student.group)) counts.set(student.group, counts.get(student.group) + 1);
  });

  elements.groupPicker.replaceChildren();
  GRADES.forEach(({ grade, label }) => {
    const box = createElement("div", "grade-box");
    box.append(createElement("span", "grade-label", label));
    const buttons = createElement("div", "grade-buttons");
    for (let section = 1; section <= 3; section += 1) {
      const group = String(grade) + "." + String(section);
      const button = createElement("button", "group-button", group);
      button.type = "button";
      const selected = !state.search && group === state.activeGroup;
      button.setAttribute("aria-pressed", String(selected));
      button.setAttribute("aria-label", "Grupo " + group + ", " + plural(counts.get(group), "estudiante", "estudiantes"));
      button.addEventListener("click", () => selectGroup(group));
      buttons.append(button);
    }
    box.append(buttons);
    elements.groupPicker.append(box);
  });
}

function excusePresentation(justification) {
  if (!justification) {
    return {
      state: "empty",
      label: "Sin excusa",
      detail: ""
    };
  }

  const stateName = text(justification.estado);
  return {
    state: EXCUSE_LABELS[stateName] ? stateName : "pendiente",
    label: EXCUSE_LABELS[stateName] || "Pendiente",
    detail: text(justification.motivo) || "Sin motivo escrito."
  };
}

function renderEvidenceThumb(event, student, evidence) {
  const button = createElement("button", "evidence-thumb");
  button.type = "button";
  button.dataset.recordId = event.id;
  button.dataset.version = String(evidence.version);
  button.setAttribute("aria-label", "Ver foto de evidencia de " + student.name + " (" + event.exactDate + ")");
  const image = createElement("img");
  image.alt = "";
  button.append(image);
  button.addEventListener("click", () => {
    if (button.dataset.state === "error") {
      thumbnailLoader.fill(button);
      return;
    }
    openEvidenceViewer(event.id, evidence.version, student.name + " · " + event.exactDate);
  });
  thumbnailLoader.observe(button);
  return button;
}

/*
 * <details> que recuerda si el usuario lo abrió o lo cerró. `fallback` es lo que se muestra
 * mientras el usuario no haya decidido (por ejemplo, el mes más reciente abierto).
 */
function rememberedDetails(className, store, key, fallback) {
  const details = createElement("details", className);
  const open = store.has(key) ? store.get(key) : fallback;
  details.open = open;
  details.dataset.renderedOpen = String(open);
  details.addEventListener("toggle", () => {
    // El evento también se dispara al pintar; sólo cuenta si el usuario cambió el estado.
    if (String(details.open) === details.dataset.renderedOpen) return;
    details.dataset.renderedOpen = String(details.open);
    store.set(key, details.open);
  });
  return details;
}

function renderEvents(student) {
  const column = createElement("section", "events-column");

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
      const details = rememberedDetails("month-block", state.openMonths, student.uid + "|" + month, index === 0);
      const summary = createElement(
        "summary",
        "",
        monthLabel(month) + " · " + plural(events.length, "llegada tarde", "llegadas tarde")
      );
      const list = createElement("div", "month-events");

      events.forEach((event) => {
        const eventRow = createElement("article", "late-event");
        const when = createElement("div", "event-when");
        when.append(createElement("span", "event-date", event.exactDate));
        when.append(createElement("span", "event-franja", event.franja));
        const excuse = excusePresentation(event.justification);
        const excuseArea = createElement("div", "event-excuse");
        const excuseText = createElement("div", "event-excuse-text");
        excuseText.append(createElement("span", "state-pill state-" + excuse.state, excuse.label));
        if (excuse.detail) excuseText.append(createElement("p", "", excuse.detail));
        excuseArea.append(excuseText);
        const evidence = event.justification ? state.evidence[event.id] : null;
        if (evidence && evidence.version) {
          excuseArea.append(renderEvidenceThumb(event, student, evidence));
        }
        eventRow.append(when, excuseArea);

        if (canManage()) {
          const reviewButton = createElement("button", "small-button", event.justification ? "Editar excusa" : "Agregar excusa");
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

function renderStudent(student, options) {
  const card = createElement("article", "student-card");
  const details = rememberedDetails("student-details", state.openStudents, student.uid, options.expand);

  const summary = createElement("summary", "student-summary");
  const main = createElement("span", "student-main");
  main.append(createElement("span", "student-name", student.name));
  const tags = createElement("span", "student-tags");
  if (options.showGroup) tags.append(createElement("span", "student-group", student.group ? "Grupo " + student.group : "Sin grupo"));
  if (student.lateToday.length) tags.append(createElement("span", "mini-tag mini-late", "Tarde hoy"));
  if (student.absentToday) tags.append(createElement("span", "mini-tag mini-absent", "Falta hoy"));
  if (tags.childElementCount) main.append(tags);

  const totals = createElement("span", "student-totals");
  const total = createElement("span", "late-total" + (student.lateEvents.length ? "" : " zero"), String(student.lateEvents.length));
  total.setAttribute("aria-label", plural(student.lateEvents.length, "llegada tarde", "llegadas tarde"));
  totals.append(total);
  totals.append(createElement(
    "span",
    "late-caption",
    (student.lateEvents.length === 1 ? "llegada tarde" : "llegadas tarde") +
      (student.lateThisMonth ? " · " + String(student.lateThisMonth) + " este mes" : "")
  ));
  summary.append(main, totals, createElement("span", "chevron"));

  const body = createElement("div", "student-body");
  const meta = createElement("div", "student-meta");
  meta.append(createElement("span", "uid-text", "Tarjeta: " + student.uid));
  if (canManage()) {
    const removeButton = createElement("button", "link-button danger", "Quitar estudiante");
    removeButton.type = "button";
    removeButton.addEventListener("click", () => removeStudent(student));
    meta.append(removeButton);
  }
  body.append(meta, renderEvents(student));

  details.append(summary, body);
  card.append(details);
  return card;
}

function renderToday(members, model) {
  elements.todayTitle.textContent = "Hoy · " + formatDayLong(model.today);
  const off = noClassPeriodFor(model.today, state.activeGroup);
  elements.todayOffNotice.hidden = !off;
  elements.todayGrid.hidden = Boolean(off);
  if (off) {
    elements.todayOffNotice.textContent = (off.groups ? "Hoy el grupo " + state.activeGroup + " no tiene clases: " : "Hoy no hay clases: ") +
      off.motivo + ". No se cuentan llegadas tarde ni faltas.";
    return;
  }

  // Llegadas tarde de hoy, de la más reciente a la más antigua.
  const lateToday = [];
  members.forEach((student) => student.lateToday.forEach((event) => lateToday.push({ event, student })));
  lateToday.sort((first, second) => second.event.timestamp - first.event.timestamp);
  elements.todayLateCount.textContent = String(lateToday.length);
  elements.todayLateList.replaceChildren();
  if (!lateToday.length) {
    elements.todayLateList.append(createElement("p", "today-empty", "Nadie de este grupo ha llegado tarde hoy."));
  }
  lateToday.forEach(({ event, student }) => {
    const row = createElement("div", "today-row");
    row.append(createElement("span", "today-time", clockLabel(event.time) || "—"));
    const who = createElement("span", "today-who");
    who.append(createElement("strong", "", student.name));
    who.append(createElement("small", "", event.franja));
    row.append(who);
    const excuse = excusePresentation(event.justification);
    row.append(createElement("span", "state-pill state-" + excuse.state, excuse.label));
    if (canManage()) {
      const button = createElement("button", "small-button", event.justification ? "Editar" : "Excusa");
      button.type = "button";
      button.setAttribute("aria-label", (event.justification ? "Editar excusa de " : "Agregar excusa de ") + student.name);
      button.addEventListener("click", () => openExcuseDialog(event, student));
      row.append(button);
    }
    elements.todayLateList.append(row);
  });

  // Faltas: estudiantes del grupo sin ninguna lectura hoy.
  const absences = members.filter((student) => student.absentToday);
  elements.faltasCount.textContent = String(absences.length);
  elements.faltasContainer.replaceChildren();
  if (!model.readingStarted) {
    elements.faltasContainer.append(createElement(
      "p",
      "today-empty",
      "Aún no hay lecturas del lector hoy. Las faltas aparecen cuando empieza el registro."
    ));
    return;
  }
  if (!absences.length) {
    elements.faltasContainer.append(createElement("p", "today-empty", "Todos los estudiantes de este grupo tienen registro hoy."));
    return;
  }
  absences.forEach((student) => {
    const falta = { uid: student.uid, name: student.name, group: student.group, fecha: model.today, faltaExcuse: student.faltaExcuse };
    const card = createElement("div", "falta-card today-row");
    const who = createElement("span", "today-who");
    who.append(createElement("strong", "falta-name", student.name));
    card.append(who);
    const excuse = faltaExcusePresentation(falta);
    const pill = createElement("span", "state-pill state-" + (excuse.state === "empty" ? "falta" : excuse.state), excuse.state === "empty" ? "Sin excusa" : excuse.label);
    if (excuse.detail) pill.title = excuse.detail;
    card.append(pill);
    if (canManage()) {
      const button = createElement("button", "small-button", falta.faltaExcuse ? "Editar" : "Excusa");
      button.type = "button";
      button.setAttribute("aria-label", (falta.faltaExcuse ? "Editar excusa de la falta de " : "Agregar excusa a la falta de ") + student.name);
      button.addEventListener("click", () => openFaltaExcuseDialog(falta));
      card.append(button);
    }
    elements.faltasContainer.append(card);
  });
}

function renderGroup(model) {
  const rows = model.rows;
  const search = searchText(state.search);
  const isSearching = Boolean(search);

  const groupMembers = rows
    .filter((student) => student.group === state.activeGroup)
    .sort((first, second) => groupCollator.compare(first.name, second.name));
  const visibleMembers = isSearching
    ? rows
      .filter((student) =>
        searchText(student.name).includes(search) ||
        searchText(student.group).includes(search) ||
        searchText(student.uid).includes(search))
      .sort((first, second) => {
        if (first.group !== second.group) return groupCollator.compare(first.group, second.group);
        return groupCollator.compare(first.name, second.name);
      })
    : groupMembers;

  elements.todaySection.hidden = isSearching;
  elements.groupReportButton.hidden = isSearching;
  elements.activeGroupLabel.textContent = isSearching ? "Búsqueda en todos los grupos" : "Grupo seleccionado";
  elements.activeGroupTitle.textContent = isSearching ? "Resultados de «" + state.search + "»" : "Grupo " + state.activeGroup;

  if (isSearching) {
    elements.activeGroupCount.textContent = plural(visibleMembers.length, "resultado", "resultados");
  } else {
    const monthTotal = groupMembers.reduce((total, student) => total + student.lateThisMonth, 0);
    elements.activeGroupCount.textContent =
      plural(groupMembers.length, "estudiante", "estudiantes") + " · " +
      plural(monthTotal, "llegada tarde", "llegadas tarde") + " este mes";
    renderToday(groupMembers, model);
  }

  elements.studentsHeading.textContent = isSearching ? "Estudiantes encontrados" : "Estudiantes del grupo";
  elements.studentsContainer.replaceChildren();

  if (!visibleMembers.length) {
    const empty = createElement("section", "empty-state");
    empty.append(createElement("h3", "", isSearching ? "No hay coincidencias" : "Aún no hay estudiantes en este grupo"));
    empty.append(createElement(
      "p",
      "",
      isSearching
        ? "Prueba con otro nombre o con el código de la tarjeta."
        : canManage()
          ? "Usa «Añadir estudiante» para registrar el primer estudiante de este grupo."
          : "Cuando coordinación registre estudiantes, aparecerán aquí automáticamente."
    ));
    elements.studentsContainer.append(empty);
    return;
  }

  const expand = isSearching && visibleMembers.length <= SEARCH_AUTO_EXPAND;
  visibleMembers.forEach((student) => {
    elements.studentsContainer.append(renderStudent(student, { showGroup: isSearching, expand }));
  });
}

/* ---------- Sistema de faltas (inasistencias) ---------- */

function faltaKey(fecha, uid) {
  return fecha + "_" + uid;
}

function faltaExcusePresentation(falta) {
  if (!falta.faltaExcuse || !falta.faltaExcuse.justificacion) {
    return { state: "empty", label: "Sin excusa", detail: "" };
  }
  return excusePresentation(falta.faltaExcuse.justificacion);
}

function getExcuseStatus() {
  const checked = elements.excuseStatusInputs.find((input) => input.checked);
  return checked ? checked.value : "";
}

function setExcuseStatus(value) {
  const status = EXCUSE_LABELS[value] ? value : "pendiente";
  elements.excuseStatusInputs.forEach((input) => {
    input.checked = input.value === status;
  });
}

function prepareExcuseDialog(kind, info, justification) {
  const isFalta = kind === "falta";
  elements.excuseDialogEyebrow.textContent = isFalta ? "Falta" : "Llegada tarde";
  elements.excuseDialogTitle.textContent = justification
    ? (isFalta ? "Editar excusa de la falta" : "Editar excusa")
    : (isFalta ? "Agregar excusa a la falta" : "Agregar excusa");
  elements.excuseReasonLabel.textContent = isFalta ? "Motivo de la falta" : "Motivo de la llegada tarde";
  elements.excuseRecordInfo.textContent = info;
  setExcuseStatus(justification ? text(justification.estado) : "pendiente");
  elements.excuseReasonInput.value = justification ? text(justification.motivo) : "";
  elements.deleteExcuseButton.hidden = !justification;
  // Las fotos de evidencia sólo existen para llegadas tarde; el rango de días, sólo para faltas.
  elements.evidenceSection.hidden = isFalta;
  elements.faltaRangeSection.hidden = !isFalta;
  showExcuseFormError("");
}

// Una excusa de falta puede cubrir varios días (por ejemplo, una incapacidad). Se guarda en cada
// día de clase del rango (sin sábados, domingos ni días sin clases del grupo) y siempre en el día
// de la falta que se está excusando. Las llegadas tarde siguen siendo de un solo registro.
const MAX_FALTA_RANGE_DAYS = 31;

function faltaRangeDays(falta, from, to) {
  if (!isDayKey(from) || !isDayKey(to)) return { error: "Elige las fechas Desde y Hasta.", days: [] };
  if (to < from) return { error: "La fecha Hasta no puede ser anterior a Desde.", days: [] };
  if (dayNumber(to) - dayNumber(from) + 1 > MAX_FALTA_RANGE_DAYS) {
    return { error: "El rango puede cubrir como máximo " + MAX_FALTA_RANGE_DAYS + " días.", days: [] };
  }
  if (falta.fecha < from || falta.fecha > to) {
    return { error: "El rango debe incluir el día de la falta (" + shortDayLabel(falta.fecha) + ").", days: [] };
  }
  const days = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const schoolDay = weekdayFromMonday(day) < 5 && !noClassPeriodFor(day, falta.group);
    if (schoolDay || day === falta.fecha) days.push(day);
  }
  return { error: "", days };
}

function renderFaltaRangeSummary() {
  const falta = state.editingFalta;
  if (!falta) return;
  const { error, days } = faltaRangeDays(falta, elements.faltaFromInput.value, elements.faltaToInput.value);
  if (error) {
    elements.faltaRangeSummary.textContent = error;
    return;
  }
  if (days.length === 1) {
    elements.faltaRangeSummary.textContent = "Sólo la falta del " + shortDayLabel(days[0]) + ".";
    return;
  }
  const shown = days.slice(0, 6).map(shortDayLabel).join(", ");
  const others = days.filter((day) => day !== falta.fecha && state.faltas[faltaKey(day, falta.uid)]).length;
  elements.faltaRangeSummary.textContent =
    "Cubre " + days.length + " días de clase: " + shown + (days.length > 6 ? " y " + (days.length - 6) + " más" : "") + "." +
    (others === 1 ? " 1 día ya tenía excusa y se reemplazará." : "") +
    (others > 1 ? " " + others + " días ya tenían excusa y se reemplazarán." : "");
}

function openFaltaExcuseDialog(falta) {
  if (!canManage()) return;
  state.editingFalta = falta;
  state.editingRecordId = null; // No es un registro de tardanza
  discardPendingEvidence(state.evidenceEditor);
  state.evidenceEditor = null;

  const existing = falta.faltaExcuse && falta.faltaExcuse.justificacion;
  prepareExcuseDialog(
    "falta",
    falta.name + " · Grupo " + falta.group + " · Falta del " + formatDayLong(falta.fecha),
    existing || null
  );
  elements.faltaFromInput.value = falta.fecha;
  elements.faltaToInput.value = falta.fecha;
  renderFaltaRangeSummary();
  openDialog(elements.excuseDialog);
  elements.excuseReasonInput.focus();
}

async function saveFaltaExcuse(status, reason) {
  const falta = state.editingFalta;
  if (!canManage() || !falta) return false;

  const { error, days } = faltaRangeDays(falta, elements.faltaFromInput.value, elements.faltaToInput.value);
  if (error) {
    showExcuseFormError(error);
    return false;
  }

  elements.saveExcuseButton.disabled = true;
  showExcuseFormError("");
  try {
    // Una sola escritura: o quedan guardados todos los días, o ninguno.
    const changes = {};
    days.forEach((day) => {
      changes["faltas/" + faltaKey(day, falta.uid)] = {
        uid: falta.uid,
        nombre: falta.name,
        grupo: normalizeGroup(falta.group),
        fecha: day,
        justificacion: {
          estado: status,
          motivo: reason,
          revisadaPorUid: state.authUser.uid,
          revisadaEn: serverTimestamp()
        }
      };
    });
    await update(ref(database), changes);
    closeDialog(elements.excuseDialog);
    setStatus(days.length === 1
      ? "Excusa de la falta guardada."
      : "Excusa de la falta guardada para " + days.length + " días de clase.", false);
    return true;
  } catch (error) {
    console.error("No fue posible guardar la excusa de falta", error);
    showExcuseFormError("No se pudo guardar. Verifica tu rol y que las reglas de Firebase estén publicadas.");
    return false;
  } finally {
    elements.saveExcuseButton.disabled = false;
  }
}

async function deleteFaltaExcuse() {
  const falta = state.editingFalta;
  if (!canManage() || !falta) return;
  if (!window.confirm("¿Quitar la excusa de la falta del " + shortDayLabel(falta.fecha) + "? Los demás días conservan la suya.")) return;

  elements.deleteExcuseButton.disabled = true;
  try {
    await remove(ref(database, "faltas/" + faltaKey(falta.fecha, falta.uid)));
    closeDialog(elements.excuseDialog);
    setStatus("Excusa de la falta retirada.", false);
  } catch (error) {
    console.error("No fue posible quitar la excusa de falta", error);
    showExcuseFormError("No se pudo quitar. Inténtalo de nuevo.");
  } finally {
    elements.deleteExcuseButton.disabled = false;
  }
}

function render() {
  const model = buildModel();
  renderWarning(model.rows);
  renderGroupPicker(model.rows);
  renderGroup(model);
  statsView.refresh();
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
  state.editingFalta = null;
  prepareExcuseDialog(
    "tarde",
    student.name + " · Grupo " + student.group + " · " + event.exactDate + " · " + event.franja,
    event.justification
  );
  openEvidenceEditor(event);
  openDialog(elements.excuseDialog);
  elements.excuseReasonInput.focus();
}

async function removeStudent(student) {
  if (!canManage()) return;
  const confirmed = window.confirm(
    "¿Quitar a " + student.name + " del grupo " + student.group +
    "? Sus registros históricos de tardanza se conservarán."
  );
  if (!confirmed) return;

  try {
    await remove(ref(database, "estudiantes/" + student.firebaseKey));
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
  if (!canManage()) return;

  const status = getExcuseStatus();
  const reason = text(elements.excuseReasonInput.value);
  if (!EXCUSE_LABELS[status]) {
    showExcuseFormError("Selecciona un estado válido.");
    return;
  }
  if (!reason) {
    showExcuseFormError("Escribe el motivo o la explicación.");
    return;
  }

  // Si se está editando una falta, usar el flujo de faltas.
  if (state.editingFalta && !state.editingRecordId) {
    await saveFaltaExcuse(status, reason);
    return;
  }

  if (!state.editingRecordId) return;

  const editor = state.evidenceEditor;
  const previous = editor && editor.justification;
  // Si sólo cambió la foto, no se reescribe la excusa (conserva quién y cuándo la revisó).
  const excuseChanged = !previous || text(previous.estado) !== status || text(previous.motivo) !== reason;

  elements.saveExcuseButton.disabled = true;
  showExcuseFormError("");
  try {
    if (excuseChanged) {
      await update(ref(database, "registros/" + state.editingRecordId), {
        justificacion: {
          estado: status,
          motivo: reason,
          revisadaPorUid: state.authUser.uid,
          revisadaEn: serverTimestamp()
        }
      });
      if (editor) editor.justification = { estado: status, motivo: reason };
    }
  } catch (error) {
    console.error("No fue posible guardar excusa", error);
    showExcuseFormError("No se pudo guardar la revisión. Verifica que tu rol sea Directivo o Administrador.");
    elements.saveExcuseButton.disabled = false;
    return;
  }

  const uploaded = editor && editor.pending ? await uploadPendingEvidence() : true;
  elements.saveExcuseButton.disabled = false;
  if (!uploaded) return;
  closeDialog(elements.excuseDialog);
  setStatus(editor && editor.uploadedNow ? "Excusa y foto guardadas." : "Excusa actualizada.", false);
}

async function deleteExcuse() {
  if (!canManage()) return;

  // Si se está editando una falta, usar el flujo de faltas.
  if (state.editingFalta && !state.editingRecordId) {
    await deleteFaltaExcuse();
    return;
  }

  if (!state.editingRecordId) return;
  if (!window.confirm("¿Quitar esta excusa y su motivo?")) return;

  elements.deleteExcuseButton.disabled = true;
  try {
    // Primero la foto: así nunca queda una evidencia huérfana sin excusa.
    if (state.evidence[state.editingRecordId]) {
      await evidenceClient.remove(state.editingRecordId);
    }
    await remove(ref(database, "registros/" + state.editingRecordId + "/justificacion"));
    closeDialog(elements.excuseDialog);
    setStatus("Excusa retirada.", false);
  } catch (error) {
    console.error("No fue posible quitar excusa", error);
    showExcuseFormError(
      String(error && error.code || "").startsWith("functions/")
        ? "No se pudo quitar la foto adjunta, así que la excusa se conservó. " + evidenceErrorMessage(error)
        : "No se pudo quitar la excusa. Inténtalo de nuevo."
    );
  } finally {
    elements.deleteExcuseButton.disabled = false;
  }
}

/* ---------- Foto de evidencia en el diálogo de excusa (sólo directivo y admin) ---------- */

function setEvidenceStatus(message, kind) {
  elements.evidenceStatus.textContent = message || "";
  elements.evidenceStatus.dataset.kind = kind || "";
}

function discardPendingEvidence(editor) {
  if (editor && editor.pendingUrl) URL.revokeObjectURL(editor.pendingUrl);
  if (editor) {
    editor.pending = null;
    editor.pendingUrl = "";
    editor.failed = false;
  }
}

function renderEvidenceEditor() {
  const editor = state.evidenceEditor;
  if (!editor) return;
  const existing = state.evidence[editor.recordId] || null;
  const hasPhoto = Boolean(editor.pending || existing);

  elements.evidenceFileButton.textContent = hasPhoto ? "Reemplazar foto" : "Elegir archivo";
  elements.evidenceCameraButton.textContent = hasPhoto ? "Tomar otra foto" : "Tomar foto";
  elements.evidenceRemoveButton.hidden = !hasPhoto;
  elements.evidenceRemoveButton.textContent = editor.pending ? "Descartar foto nueva" : "Quitar foto";
  elements.evidenceRetryButton.hidden = !editor.failed;
  [elements.evidenceFileButton, elements.evidenceCameraButton, elements.evidenceRemoveButton, elements.evidenceRetryButton]
    .forEach((button) => { button.disabled = editor.busy; });
  elements.evidenceDropZone.classList.toggle("has-photo", hasPhoto);
  elements.evidenceDropText.hidden = hasPhoto;

  if (editor.pending) {
    elements.evidencePreview.src = editor.pendingUrl;
    elements.evidencePreview.hidden = false;
  } else if (existing) {
    const requested = editor.recordId + ":" + existing.version;
    elements.evidencePreview.dataset.requested = requested;
    elements.evidencePreview.hidden = true;
    evidenceClient.load(editor.recordId, existing.version, "mini")
      .then((url) => {
        if (elements.evidencePreview.dataset.requested !== requested || state.evidenceEditor !== editor || editor.pending) return;
        elements.evidencePreview.src = url;
        elements.evidencePreview.hidden = false;
      })
      .catch((error) => {
        if (state.evidenceEditor === editor && !editor.busy) setEvidenceStatus(evidenceErrorMessage(error), "error");
      });
  } else {
    elements.evidencePreview.hidden = true;
    elements.evidencePreview.removeAttribute("src");
  }
}

function openEvidenceEditor(event) {
  discardPendingEvidence(state.evidenceEditor);
  state.evidenceEditor = {
    recordId: event.id,
    justification: event.justification ? { estado: event.justification.estado, motivo: event.justification.motivo } : null,
    pending: null,
    pendingUrl: "",
    busy: false,
    failed: false,
    uploadedNow: false
  };
  const existing = state.evidence[event.id];
  setEvidenceStatus(existing ? "Foto adjunta. Puedes reemplazarla o quitarla." : "", "");
  elements.evidenceCameraButton.hidden = !window.matchMedia("(pointer: coarse)").matches;
  renderEvidenceEditor();
}

async function handleEvidenceFile(file) {
  const editor = state.evidenceEditor;
  if (!editor || editor.busy || !file || !canManage()) return;
  editor.busy = true;
  renderEvidenceEditor();
  setEvidenceStatus("Preparando la foto…", "busy");
  try {
    const prepared = await prepareImage(file);
    if (state.evidenceEditor !== editor) return;
    discardPendingEvidence(editor);
    editor.pending = prepared;
    editor.pendingUrl = URL.createObjectURL(prepared.full);
    setEvidenceStatus(
      "Foto lista (" + formatBytes(prepared.full.size) + "). Se subirá al pulsar «Guardar».",
      "ready"
    );
  } catch (error) {
    // Un archivo no válido es un error del usuario, no de la aplicación: sólo se le informa.
    if (!(error instanceof EvidenceError)) console.error("No fue posible preparar la foto", error);
    setEvidenceStatus(evidenceErrorMessage(error), "error");
  } finally {
    editor.busy = false;
    renderEvidenceEditor();
  }
}

async function uploadPendingEvidence() {
  const editor = state.evidenceEditor;
  if (!editor || !editor.pending) return true;
  editor.busy = true;
  editor.failed = false;
  renderEvidenceEditor();
  setEvidenceStatus("Subiendo foto… con conexión lenta puede tardar un poco.", "busy");
  try {
    await evidenceClient.upload(editor.recordId, editor.pending);
    discardPendingEvidence(editor);
    editor.uploadedNow = true;
    setEvidenceStatus("Foto guardada.", "ready");
    return true;
  } catch (error) {
    console.error("No fue posible subir la foto", error);
    editor.failed = true;
    setEvidenceStatus("La excusa quedó guardada, pero la foto no se pudo subir. " + evidenceErrorMessage(error), "error");
    return false;
  } finally {
    editor.busy = false;
    renderEvidenceEditor();
  }
}

async function removeEvidence() {
  const editor = state.evidenceEditor;
  if (!editor || editor.busy || !canManage()) return;
  if (editor.pending) {
    discardPendingEvidence(editor);
    setEvidenceStatus(state.evidence[editor.recordId] ? "Se conserva la foto anterior." : "", "");
    renderEvidenceEditor();
    return;
  }
  if (!window.confirm("¿Quitar la foto de evidencia? Se borrará de forma permanente.")) return;
  editor.busy = true;
  renderEvidenceEditor();
  setEvidenceStatus("Quitando la foto…", "busy");
  try {
    await evidenceClient.remove(editor.recordId);
    delete state.evidence[editor.recordId];
    setEvidenceStatus("Foto quitada.", "ready");
    render();
  } catch (error) {
    console.error("No fue posible quitar la foto", error);
    setEvidenceStatus(evidenceErrorMessage(error), "error");
  } finally {
    editor.busy = false;
    renderEvidenceEditor();
  }
}

/* ---------- Visor ampliado (todos los roles) ---------- */

let viewerRequest = 0;

function openEvidenceViewer(recordId, version, caption) {
  const requestId = viewerRequest + 1;
  viewerRequest = requestId;
  elements.evidenceViewerTitle.textContent = caption;
  elements.evidenceViewerImage.hidden = true;
  elements.evidenceViewerImage.removeAttribute("src");
  elements.evidenceViewerRetry.hidden = true;
  elements.evidenceViewerStatus.classList.remove("error");
  elements.evidenceViewerStatus.textContent = "Cargando la foto…";
  elements.evidenceViewerRetry.onclick = () => openEvidenceViewer(recordId, version, caption);
  openDialog(elements.evidenceViewer);

  // Primero la miniatura (normalmente ya está en memoria) y luego la versión completa.
  evidenceClient.load(recordId, version, "mini").then((url) => {
    if (viewerRequest !== requestId || !elements.evidenceViewerImage.hidden) return;
    elements.evidenceViewerImage.src = url;
    elements.evidenceViewerImage.hidden = false;
  }, () => undefined);
  evidenceClient.load(recordId, version, "completa")
    .then((url) => {
      if (viewerRequest !== requestId) return;
      elements.evidenceViewerImage.src = url;
      elements.evidenceViewerImage.hidden = false;
      elements.evidenceViewerStatus.textContent = "";
    })
    .catch((error) => {
      if (viewerRequest !== requestId) return;
      console.error("No fue posible cargar la foto", error);
      elements.evidenceViewerStatus.classList.add("error");
      elements.evidenceViewerStatus.textContent = evidenceErrorMessage(error);
      elements.evidenceViewerRetry.hidden = false;
    });
}

function setManagedUsersStatus(message, isError) {
  elements.managedUsersStatus.textContent = message;
  elements.managedUsersStatus.classList.toggle("error", Boolean(isError));
}

function userAdminErrorMessage(error) {
  const code = text(error && error.code);
  if (code === "functions/permission-denied") {
    return "Esta acción sólo está disponible para administradores activos.";
  }
  if (code === "functions/invalid-argument") {
    return text(error && error.message) || "Revisa los datos del usuario.";
  }
  if (code === "functions/already-exists") {
    return "Ya existe una cuenta con ese correo.";
  }
  if (code === "functions/not-found") {
    return "No se encontró esa cuenta.";
  }
  return "No fue posible completar la operación. Verifica que la Cloud Function manageUsers esté publicada.";
}

function resetUserForm() {
  state.editingUserUid = null;
  elements.userForm.reset();
  elements.managedUserActiveInput.checked = true;
  elements.userFormTitle.textContent = "Añadir usuario";
  elements.managedPasswordLabel.textContent = "Contraseña inicial";
  elements.managedUserPasswordInput.required = true;
  elements.managedUserPasswordInput.placeholder = "Mínimo 8 caracteres";
  elements.saveUserButton.textContent = "Crear usuario";
  elements.cancelUserEditButton.hidden = true;
  showUserFormError("");
}

function renderManagedUsers() {
  elements.managedUsersContainer.replaceChildren();
  if (!state.managedUsers.length) {
    const empty = createElement("p", "events-empty", "No hay cuentas de personal registradas.");
    elements.managedUsersContainer.append(empty);
    return;
  }

  state.managedUsers.forEach((user) => {
    const row = createElement("article", "managed-user-row");
    const identity = createElement("div");
    const name = text(user.profile && user.profile.nombre) || text(user.displayName) || "Sin nombre";
    identity.append(createElement("p", "managed-user-name", name));
    identity.append(createElement("p", "managed-user-email", text(user.email) || "Correo no disponible"));

    const meta = createElement("div", "managed-user-meta");
    const role = text(user.profile && user.profile.rol);
    meta.append(createElement("span", "role-pill", roleLabel(role)));
    const active = user.profile && user.profile.activo === true && user.disabled !== true;
    meta.append(createElement("span", "state-pill " + (active ? "state-validada" : "inactive-pill"), active ? "Activa" : "Inactiva"));

    const actions = createElement("div", "managed-user-actions");
    const editButton = createElement("button", "small-button", "Editar");
    editButton.type = "button";
    editButton.addEventListener("click", () => editManagedUser(user));
    actions.append(editButton);

    // Evita que un administrador borre sin querer la sesión con la que está trabajando.
    if (user.uid !== state.authUser.uid) {
      const deleteButton = createElement("button", "small-button danger", "Quitar");
      deleteButton.type = "button";
      deleteButton.addEventListener("click", () => deleteManagedUser(user));
      actions.append(deleteButton);
    }
    row.append(identity, meta, actions);
    elements.managedUsersContainer.append(row);
  });
}

async function loadManagedUsers() {
  if (!isAdmin()) return;
  elements.refreshUsersButton.disabled = true;
  setManagedUsersStatus("Cargando usuarios…", false);
  try {
    const response = await manageUsersCallable({ action: "list" });
    state.managedUsers = Array.isArray(response.data && response.data.users) ? response.data.users : [];
    renderManagedUsers();
    setManagedUsersStatus(String(state.managedUsers.length) + " cuenta(s) cargada(s).", false);
  } catch (error) {
    console.error("No fue posible cargar los usuarios", error);
    state.managedUsers = [];
    renderManagedUsers();
    setManagedUsersStatus(userAdminErrorMessage(error), true);
  } finally {
    elements.refreshUsersButton.disabled = false;
  }
}

function openUserAdminDialog() {
  if (!isAdmin()) return;
  resetUserForm();
  openDialog(elements.userAdminDialog);
  loadManagedUsers();
}

function editManagedUser(user) {
  if (!isAdmin()) return;
  state.editingUserUid = text(user.uid);
  elements.userFormTitle.textContent = "Editar usuario";
  elements.managedUserNameInput.value = text(user.profile && user.profile.nombre) || text(user.displayName);
  elements.managedUserEmailInput.value = text(user.email);
  elements.managedUserRoleInput.value = ROLE_LABELS[text(user.profile && user.profile.rol)]
    ? text(user.profile.rol)
    : "docente";
  elements.managedUserActiveInput.checked = Boolean(user.profile && user.profile.activo === true && user.disabled !== true);
  elements.managedPasswordLabel.textContent = "Nueva contraseña (opcional)";
  elements.managedUserPasswordInput.value = "";
  elements.managedUserPasswordInput.required = false;
  elements.managedUserPasswordInput.placeholder = "Déjala vacía para conservarla";
  elements.saveUserButton.textContent = "Guardar cambios";
  elements.cancelUserEditButton.hidden = false;
  showUserFormError("");
  elements.managedUserNameInput.focus();
}

async function saveManagedUser(event) {
  event.preventDefault();
  if (!isAdmin()) return;

  const name = text(elements.managedUserNameInput.value);
  const email = text(elements.managedUserEmailInput.value).toLocaleLowerCase("es-CO");
  const role = text(elements.managedUserRoleInput.value);
  const password = elements.managedUserPasswordInput.value;
  const active = elements.managedUserActiveInput.checked;
  const isEditing = Boolean(state.editingUserUid);

  if (!name || name.length > 80) {
    showUserFormError("Escribe un nombre de máximo 80 caracteres.");
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showUserFormError("Escribe un correo válido.");
    return;
  }
  if (!ROLE_LABELS[role]) {
    showUserFormError("Selecciona un rol válido.");
    return;
  }
  if ((!isEditing && password.length < 8) || (isEditing && password && password.length < 8)) {
    showUserFormError("La contraseña debe tener al menos 8 caracteres.");
    return;
  }

  elements.saveUserButton.disabled = true;
  showUserFormError("");
  try {
    const payload = { nombre: name, email, rol: role, activo: active };
    if (password) payload.password = password;
    if (isEditing) payload.uid = state.editingUserUid;
    await manageUsersCallable({ action: isEditing ? "update" : "create", ...payload });
    resetUserForm();
    await loadManagedUsers();
  } catch (error) {
    console.error("No fue posible guardar el usuario", error);
    showUserFormError(userAdminErrorMessage(error));
  } finally {
    elements.saveUserButton.disabled = false;
  }
}

async function deleteManagedUser(user) {
  if (!isAdmin() || user.uid === state.authUser.uid) return;
  const name = text(user.profile && user.profile.nombre) || text(user.email);
  if (!window.confirm("¿Quitar la cuenta de " + name + "? No podrá volver a iniciar sesión.")) return;

  try {
    await manageUsersCallable({ action: "delete", uid: user.uid });
    if (state.editingUserUid === user.uid) resetUserForm();
    await loadManagedUsers();
  } catch (error) {
    console.error("No fue posible quitar el usuario", error);
    showUserFormError(userAdminErrorMessage(error));
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

elements.adminUsersButton.addEventListener("click", openUserAdminDialog);
elements.searchInput.addEventListener("input", (event) => {
  state.search = text(event.target.value);
  render();
});
elements.addStudentButton.addEventListener("click", openStudentDialog);
elements.deleteOldYearsButton.addEventListener("click", deleteOldYears);
elements.statsButton.addEventListener("click", () => {
  if (isActiveStaff(state.profile)) statsView.open();
});
// Atajo: el informe del mes del grupo que se está viendo.
elements.calendarButton.addEventListener("click", () => {
  if (isActiveStaff(state.profile)) openCalendar();
});
elements.calendarPrev.addEventListener("click", () => moveCalendar(-1));
elements.calendarNext.addEventListener("click", () => moveCalendar(1));
elements.calendarForm.addEventListener("submit", saveNoClassPeriod);
elements.calendarScopeInputs.forEach((input) => {
  input.addEventListener("change", () => {
    elements.calendarGroups.hidden = calendarScope() === "todos";
    showCalendarError("");
  });
});
buildCalendarGroupPicker();
elements.calendarClear.addEventListener("click", () => {
  state.calendar.start = "";
  state.calendar.end = "";
  state.calendar.notice = "";
  resetCalendarGroups();
  elements.calendarReason.value = "";
  showCalendarError("");
  renderCalendar();
});
[elements.calendarFrom, elements.calendarTo].forEach((input) => {
  input.addEventListener("change", () => {
    const from = isDayKey(elements.calendarFrom.value) ? elements.calendarFrom.value : "";
    const to = isDayKey(elements.calendarTo.value) ? elements.calendarTo.value : "";
    state.calendar.start = from && to && to < from ? to : from || to;
    state.calendar.end = from && to ? (to < from ? from : to) : "";
    if (state.calendar.start) state.calendar.month = monthKeyOf(state.calendar.start);
    renderCalendar();
  });
});
elements.groupReportButton.addEventListener("click", () => {
  if (isActiveStaff(state.profile)) statsView.open({ period: "mes", group: state.activeGroup });
});
elements.studentForm.addEventListener("submit", saveStudent);
elements.excuseForm.addEventListener("submit", saveExcuse);
elements.deleteExcuseButton.addEventListener("click", deleteExcuse);
elements.faltaFromInput.addEventListener("input", renderFaltaRangeSummary);
elements.faltaToInput.addEventListener("input", renderFaltaRangeSummary);
elements.evidenceFileButton.addEventListener("click", () => elements.evidenceFileInput.click());
elements.evidenceCameraButton.addEventListener("click", () => elements.evidenceCameraInput.click());
[elements.evidenceFileInput, elements.evidenceCameraInput].forEach((input) => {
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    input.value = "";
    handleEvidenceFile(file);
  });
});
elements.evidenceRemoveButton.addEventListener("click", removeEvidence);
elements.evidenceRetryButton.addEventListener("click", async () => {
  if (await uploadPendingEvidence()) {
    closeDialog(elements.excuseDialog);
    setStatus("Excusa y foto guardadas.", false);
  }
});
elements.evidenceDropZone.addEventListener("click", () => {
  if (state.evidenceEditor && !state.evidenceEditor.busy) elements.evidenceFileInput.click();
});
elements.evidenceDropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    elements.evidenceDropZone.click();
  }
});
["dragenter", "dragover"].forEach((type) => {
  elements.evidenceDropZone.addEventListener(type, (event) => {
    event.preventDefault();
    elements.evidenceDropZone.classList.add("is-dragging");
  });
});
["dragleave", "drop"].forEach((type) => {
  elements.evidenceDropZone.addEventListener(type, () => elements.evidenceDropZone.classList.remove("is-dragging"));
});
elements.evidenceDropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  handleEvidenceFile(file);
});
elements.excuseDialog.addEventListener("close", () => {
  discardPendingEvidence(state.evidenceEditor);
  state.evidenceEditor = null;
  elements.evidencePreview.removeAttribute("src");
});
elements.evidenceViewer.addEventListener("close", () => {
  viewerRequest += 1;
  elements.evidenceViewerImage.removeAttribute("src");
});
elements.userForm.addEventListener("submit", saveManagedUser);
elements.cancelUserEditButton.addEventListener("click", resetUserForm);
elements.refreshUsersButton.addEventListener("click", loadManagedUsers);
document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => {
    const dialog = document.querySelector("#" + button.dataset.closeDialog);
    if (dialog) closeDialog(dialog);
  });
});

// Vista de estadísticas compartida por todos los roles: sólo consulta datos ya cargados.
const statsView = createStatsView({
  // Las llegadas tarde en días sin clases no se cuentan en informes ni en el Excel.
  getEvents: () => normalizeLateEvents(state.records, state.students, state.evidence)
    .filter((event) => !noClassPeriodFor(event.day, event.group)),
  onExport: (result, range, filters) => exportToXlsx(
    result,
    range,
    filters,
    (text(state.profile && state.profile.nombre) || text(state.authUser && state.authUser.email) || "Usuario") +
      " (" + roleLabel(text(state.profile && state.profile.rol)) + ")"
  )
});

populateStudentGroups();
render();

// Sesión sólo en la pestaña actual: al cerrar el navegador hay que volver a iniciar sesión.
setPersistence(auth, browserSessionPersistence).catch((error) => {
  console.warn("No se pudo configurar la persistencia de sesión", error);
});

/* ---------- Temporizador de inactividad (25 min) ---------- */

function resetInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  if (!state.authUser) return;
  inactivityTimer = setTimeout(async () => {
    if (state.authUser) {
      window.alert("Tu sesión se cerró por inactividad (25 minutos). Vuelve a iniciar sesión.");
      try { await signOut(auth); } catch (_) { /* se ignora */ }
    }
  }, INACTIVITY_TIMEOUT_MS);
}

["click", "keydown", "scroll", "touchstart", "mousemove"].forEach((type) => {
  document.addEventListener(type, resetInactivityTimer, { passive: true });
});

onAuthStateChanged(auth, async (user) => {
  const sessionId = state.sessionId + 1;
  state.sessionId = sessionId;
  detachDatabaseListeners();
  state.students = {};
  state.records = {};
  state.faltas = {};
  state.evidence = {};
  evidenceClient.clear();
  state.authUser = null;
  state.profile = null;
  state.editingRecordId = null;
  state.editingFalta = null;
  state.openStudents.clear();
  state.openMonths.clear();
  state.noClassPeriods = {};
  state.managedUsers = [];
  state.editingUserUid = null;

  // Detener el timer si se cierra sesión.
  if (inactivityTimer) clearTimeout(inactivityTimer);

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
    watchProfile(user.uid);
    resetInactivityTimer();
  } catch (error) {
    if (sessionId !== state.sessionId) return;
    console.error("No fue posible cargar el perfil del usuario", error);
    showLoginError(profileErrorMessage(error));
    await signOut(auth);
  } finally {
    if (sessionId === state.sessionId) elements.loginButton.disabled = false;
  }
});
