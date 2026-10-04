/*
 * Sustituto mínimo del SDK de Firebase para probar la interfaz en un navegador
 * sin tocar el proyecto real. El arnés (run_ui_tests.py) intercepta las URL de
 * gstatic.com y sirve este archivo en su lugar. Los datos y el rol se leen de
 * window.__MOCK (definido antes de cargar la página).
 *
 * Aplica una versión simplificada de los permisos (sólo directivo/admin
 * escriben) para comprobar los mensajes de error de la interfaz; las reglas
 * reales se prueban con el emulador en tests/rules.test.mjs.
 */

// El mismo archivo se sirve como cuatro módulos distintos (app, auth, database,
// functions); el estado compartido vive en window.__MOCK.
const mock = window.__MOCK;
if (!mock.listeners) mock.listeners = new Set();
if (!mock.calls) mock.calls = [];
const listeners = mock.listeners;

function pathParts(path) {
  return String(path || "").split("/").filter(Boolean);
}

function readPath(path) {
  let node = mock.db;
  for (const part of pathParts(path)) {
    if (node === null || typeof node !== "object") return null;
    node = node[part];
    if (node === undefined) return null;
  }
  return node === undefined ? null : JSON.parse(JSON.stringify(node));
}

function writePath(path, value) {
  const parts = pathParts(path);
  let node = mock.db;
  parts.slice(0, -1).forEach((part) => {
    if (!node[part] || typeof node[part] !== "object") node[part] = {};
    node = node[part];
  });
  const last = parts.at(-1);
  if (value === null || value === undefined) delete node[last];
  else node[last] = JSON.parse(JSON.stringify(value));
}

function snapshot(path) {
  const value = readPath(path);
  return { val: () => value, exists: () => value !== null };
}

function notify() {
  listeners.forEach((listener) => {
    setTimeout(() => listener.callback(snapshot(listener.path)), mock.latencyMs || 0);
  });
}

function canWrite() {
  const profile = mock.db.usuarios && mock.db.usuarios[mock.user && mock.user.uid];
  return Boolean(profile && profile.activo === true && (profile.rol === "directivo" || profile.rol === "admin"));
}

function denied() {
  const error = new Error("PERMISSION_DENIED");
  error.code = "PERMISSION_DENIED";
  return error;
}

// firebase-app
export function initializeApp(config) { return { config }; }

// firebase-auth
let authCallback = null;
export function getAuth() { return {}; }
export function onAuthStateChanged(auth, callback) {
  authCallback = callback;
  setTimeout(() => callback(mock.user || null), 0);
  return () => { authCallback = null; };
}
export async function signInWithEmailAndPassword() {
  mock.user = mock.loginAs;
  if (authCallback) authCallback(mock.user);
  return { user: mock.user };
}
export async function signOut() {
  mock.user = null;
  if (authCallback) authCallback(null);
}

// firebase-database
export function getDatabase() { return {}; }
export function ref(database, path) { return { path: path || "" }; }
export function onValue(reference, callback) {
  const listener = { path: reference.path, callback };
  listeners.add(listener);
  setTimeout(() => callback(snapshot(reference.path)), mock.latencyMs || 0);
  return () => listeners.delete(listener);
}
export async function get(reference) { return snapshot(reference.path); }
export async function set(reference, value) {
  mock.calls.push({ op: "set", path: reference.path, value });
  if (!canWrite()) throw denied();
  writePath(reference.path, value);
  notify();
}
export async function update(reference, values) {
  mock.calls.push({ op: "update", path: reference.path, value: values });
  if (!canWrite()) throw denied();
  Object.entries(values).forEach(([key, value]) => writePath(reference.path + "/" + key, value));
  notify();
}
export async function remove(reference) {
  mock.calls.push({ op: "remove", path: reference.path });
  if (!canWrite()) throw denied();
  writePath(reference.path, null);
  notify();
}

// firebase-functions
export function getFunctions() { return {}; }
export function httpsCallable(functions, name) {
  return async (data) => {
    mock.calls.push({ op: "callable", name, data });
    const handler = mock.callables && mock.callables[name];
    if (!handler) {
      const error = new Error("not-found");
      error.code = "functions/not-found";
      throw error;
    }
    const result = await handler(data, { db: mock.db, writePath, notify, user: mock.user });
    return { data: result };
  };
}

window.__mockApi = { writePath, notify, readPath };
