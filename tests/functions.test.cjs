/*
 * Pruebas de la Cloud Function `evidencias` con Firebase Admin simulado en
 * memoria (base de datos y bucket). No necesitan emulador ni credenciales.
 *
 * Requisito: haber ejecutado `npm install` dentro de la carpeta functions.
 * Ejecutar desde tests: npm run test:functions
 */
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

/* ---------- Firebase Admin simulado ---------- */
const memory = { db: {}, files: new Map() };

function readPath(dbPath) {
  return dbPath.split("/").filter(Boolean).reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), memory.db);
}
function writePath(dbPath, value) {
  const parts = dbPath.split("/").filter(Boolean);
  let node = memory.db;
  parts.slice(0, -1).forEach((key) => {
    if (!node[key] || typeof node[key] !== "object") node[key] = {};
    node = node[key];
  });
  if (value === null) delete node[parts.at(-1)];
  else node[parts.at(-1)] = JSON.parse(JSON.stringify(value));
}
const fakeAdmin = {
  initializeApp() {},
  auth: () => ({}),
  database: () => ({
    ref: (dbPath) => ({
      once: async () => ({ val: () => (readPath(dbPath) === undefined ? null : JSON.parse(JSON.stringify(readPath(dbPath)))) }),
      set: async (value) => writePath(dbPath, value),
      remove: async () => writePath(dbPath, null)
    })
  }),
  storage: () => ({
    bucket: () => ({
      file: (name) => ({
        save: async (buffer, options) => memory.files.set(name, { buffer, options }),
        download: async () => {
          if (!memory.files.has(name)) {
            const error = new Error("No such object");
            error.code = 404;
            throw error;
          }
          return [memory.files.get(name).buffer];
        },
        delete: async () => memory.files.delete(name)
      }),
      deleteFiles: async ({ prefix }) => {
        [...memory.files.keys()].filter((key) => key.startsWith(prefix)).forEach((key) => memory.files.delete(key));
      }
    })
  })
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "firebase-admin") return fakeAdmin;
  return originalLoad.call(this, request, parent, isMain);
};
process.env.GCLOUD_PROJECT = "demo-ieruu";
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: "demo-ieruu" });
const functions = require(path.join(__dirname, "..", "functions", "index.js"));

/* ---------- Utilidades ---------- */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7), Buffer.from([0xff, 0xd9])]);
const MINI = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 3), Buffer.from([0xff, 0xd9])]);

function call(uid, data) {
  return functions.evidencias.run({ auth: uid ? { uid, token: {} } : undefined, data });
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    return true;
  });
}

beforeEach(() => {
  memory.files.clear();
  memory.db = {
    usuarios: {
      doc: { nombre: "D", rol: "docente", activo: true },
      dir: { nombre: "R", rol: "directivo", activo: true },
      adm: { nombre: "A", rol: "admin", activo: true },
      off: { nombre: "I", rol: "admin", activo: false }
    },
    registros: {
      conExcusa: { uid: "AA", tarde: true, justificacion: { estado: "validada", motivo: "Cita", revisadaPorUid: "dir", revisadaEn: 1 } },
      sinExcusa: { uid: "AA", tarde: true },
      aTiempo: { uid: "AA", tarde: false }
    }
  };
});

const upload = (uid, extra = {}) => call(uid, {
  action: "upload",
  registroId: "conExcusa",
  imagen: JPEG.toString("base64"),
  miniatura: MINI.toString("base64"),
  ancho: 1200,
  alto: 900,
  ...extra
});

test("directivo sube; el archivo queda privado y sin token de descarga", async () => {
  const result = await upload("dir");
  const meta = memory.db.evidencias.conExcusa;
  assert.equal(meta.version, result.version);
  assert.equal(meta.subidaPorUid, "dir");
  assert.equal(meta.ancho, 1200);
  const saved = [...memory.files.entries()];
  assert.equal(saved.length, 2);
  saved.forEach(([, file]) => {
    assert.equal(file.options.contentType, "image/jpeg");
    assert.equal(file.options.metadata.cacheControl, "private, no-store");
    assert.equal(file.options.metadata.metadata.firebaseStorageDownloadTokens, undefined);
  });
});

test("docente, cuenta inactiva y anónimo no pueden subir ni borrar", async () => {
  await rejectsWith(upload("doc"), "permission-denied");
  await rejectsWith(upload("off"), "permission-denied");
  await rejectsWith(upload(null), "unauthenticated");
  await rejectsWith(call("doc", { action: "delete", registroId: "conExcusa" }), "permission-denied");
  assert.equal(memory.files.size, 0);
});

test("todos los roles activos ven la foto; la cuenta inactiva no", async () => {
  await upload("adm");
  for (const uid of ["doc", "dir", "adm"]) {
    const mini = await call(uid, { action: "get", registroId: "conExcusa" });
    assert.equal(Buffer.from(mini.imagen, "base64").length, MINI.length);
  }
  const full = await call("doc", { action: "get", registroId: "conExcusa", tamano: "completa" });
  assert.equal(Buffer.from(full.imagen, "base64").length, JPEG.length);
  await rejectsWith(call("off", { action: "get", registroId: "conExcusa" }), "permission-denied");
  await rejectsWith(call(null, { action: "get", registroId: "conExcusa" }), "unauthenticated");
});

test("validaciones: no JPEG, demasiado grande, sin excusa, registro inexistente, id inválido", async () => {
  await rejectsWith(upload("dir", { imagen: Buffer.from("%PDF-1.7 fake").toString("base64") }), "invalid-argument");
  const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1600000), Buffer.from([0xff, 0xd9])]);
  await rejectsWith(upload("dir", { imagen: huge.toString("base64") }), "invalid-argument");
  await rejectsWith(upload("dir", { registroId: "sinExcusa" }), "failed-precondition");
  await rejectsWith(upload("dir", { registroId: "aTiempo" }), "failed-precondition");
  await rejectsWith(upload("dir", { registroId: "noExiste" }), "not-found");
  await rejectsWith(upload("dir", { registroId: "../usuarios" }), "invalid-argument");
  await rejectsWith(call("dir", { action: "get", registroId: "conExcusa" }), "not-found");
});

test("reemplazar borra la versión anterior; quitar elimina archivos y metadatos", async () => {
  const first = await upload("dir");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await upload("adm");
  assert.notEqual(first.version, second.version);
  assert.deepEqual([...memory.files.keys()].sort(), [
    "evidencias/conExcusa/" + second.version + ".jpg",
    "evidencias/conExcusa/" + second.version + "_mini.jpg"
  ]);
  await call("dir", { action: "delete", registroId: "conExcusa" });
  assert.equal(memory.files.size, 0);
  assert.equal(memory.db.evidencias.conExcusa, undefined);
});
