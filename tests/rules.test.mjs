/*
 * Pruebas de database.rules.json con el emulador de Realtime Database.
 *
 * Ejecutar desde la carpeta tests (necesita Java 21+):
 *   npm install
 *   npm run test:rules
 *
 * Cubre los tres roles, la cuenta inactiva, el acceso anónimo y, sobre todo,
 * que el lector Android (sin sesión) siga pudiendo registrar llegadas tarde.
 */
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from "@firebase/rules-unit-testing";

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-ieruu",
    database: { rules: readFileSync(new URL("../database.rules.json", import.meta.url), "utf8") }
  });
});

after(async () => {
  if (env) await env.cleanup();
});

beforeEach(async () => {
  await env.clearDatabase();
  await env.withSecurityRulesDisabled(async (context) => {
    await context.database().ref().set({
      usuarios: {
        doc: { nombre: "Docente", rol: "docente", activo: true },
        dir: { nombre: "Directiva", rol: "directivo", activo: true },
        adm: { nombre: "Admin", rol: "admin", activo: true },
        off: { nombre: "Inactivo", rol: "directivo", activo: false },
        lec: { nombre: "Lector portería", rol: "lector", activo: true },
        lecoff: { nombre: "Lector perdido", rol: "lector", activo: false }
      },
      estudiantes: {
        "5AD56CAD1D4187": { nombre: "Ñusta Ibáñez", grupo: "6.1", llegadasTarde: 1 }
      },
      registros: {
        r1: {
          uid: "5AD56CAD1D4187", nombre: "Ñusta Ibáñez", grupo: "6.1", fecha: "2026-10-03",
          hora: "07:10:00", timestamp: 1791029400000, periodo: "entrada", tarde: true
        }
      },
      evidencias: { r1: { version: 1, bytes: 1000, subidaPorUid: "dir", subidaEn: 1 } },
      config: { franjas: { entrada: { horaLimite: "07:00:00" } } }
    });
  });
});

const db = (uid) => (uid ? env.authenticatedContext(uid).database() : env.unauthenticatedContext().database());
const newRecord = {
  uid: "5AD56CAD1D4187", nombre: "Ñusta Ibáñez", grupo: "6.1", fecha: "2026-10-04",
  hora: "07:05:00", timestamp: 1791115500000, periodo: "entrada", tarde: true
};
const justification = (uid) => ({ estado: "validada", motivo: "Cita médica", revisadaPorUid: uid, revisadaEn: 1 });

test("lector con cuenta de rol lector: lee la ficha, crea el registro e incrementa en uno", async () => {
  await assertSucceeds(db("lec").ref("estudiantes/5AD56CAD1D4187").once("value"));
  await assertSucceeds(db("lec").ref("config/franjas").once("value"));
  await assertSucceeds(db("lec").ref("registros/nuevo").set(newRecord));
  await assertSucceeds(db("lec").ref("estudiantes/5AD56CAD1D4187/llegadasTarde").set(2));
  await assertFails(db("lec").ref("estudiantes/5AD56CAD1D4187/llegadasTarde").set(10));
  await assertFails(db("lec").ref("registros").once("value"));
  await assertFails(db("lec").ref("estudiantes").once("value"));
  await assertFails(db("lec").ref("registros/r1/justificacion").set(justification("lec")));
});

test("el registro debe copiar el nombre exacto de la ficha (con sus espacios)", async () => {
  await env.withSecurityRulesDisabled(async (context) => {
    await context.database().ref("estudiantes/0A0B0C0D").set({ nombre: "Ana Pérez ", grupo: "7.1", llegadasTarde: 0 });
  });
  const base = { ...newRecord, uid: "0A0B0C0D", grupo: "7.1" };
  await assertFails(db("lec").ref("registros/recortado").set({ ...base, nombre: "Ana Pérez" }));
  await assertSucceeds(db("lec").ref("registros/exacto").set({ ...base, nombre: "Ana Pérez " }));
});

test("registros y excusas no aceptan campos extra", async () => {
  await assertFails(db("lec").ref("registros/extra").set({ ...newRecord, extra: "x" }));
  await assertFails(db("dir").ref("registros/r1/extra").set("x"));
  await assertFails(db("dir").ref("registros/r1/justificacion").set({ ...justification("dir"), extra: true }));
  await assertSucceeds(db("dir").ref("registros/r1/justificacion").set(justification("dir")));
});

test("docente, directivo y admin activos también pueden usar el lector", async () => {
  for (const uid of ["doc", "dir", "adm"]) {
    await assertSucceeds(db(uid).ref("estudiantes/5AD56CAD1D4187").once("value"));
    await assertSucceeds(db(uid).ref("registros/lector-" + uid).set(newRecord));
  }
  await assertSucceeds(db("dir").ref("estudiantes/5AD56CAD1D4187/llegadasTarde").set(2));
});

test("sin sesión o con cuentas desactivadas no se pueden fabricar lecturas", async () => {
  for (const uid of [null, "lecoff", "off"]) {
    await assertFails(db(uid).ref("registros/falso").set(newRecord));
    await assertFails(db(uid).ref("estudiantes/5AD56CAD1D4187/llegadasTarde").set(2));
  }
  await assertFails(db(null).ref("estudiantes/5AD56CAD1D4187").once("value"));
  await assertFails(db("lecoff").ref("estudiantes/5AD56CAD1D4187").once("value"));
});

test("sin sesión no se leen registros, usuarios ni evidencias", async () => {
  await assertFails(db(null).ref("registros").once("value"));
  await assertFails(db(null).ref("evidencias").once("value"));
  await assertFails(db(null).ref("usuarios/doc").once("value"));
});

test("docente: lee todo lo del panel y no escribe nada", async () => {
  await assertSucceeds(db("doc").ref("registros").once("value"));
  await assertSucceeds(db("doc").ref("estudiantes").once("value"));
  await assertSucceeds(db("doc").ref("evidencias").once("value"));
  await assertFails(db("doc").ref("registros/r1/justificacion").set(justification("doc")));
  await assertFails(db("doc").ref("evidencias/r1").remove());
  await assertFails(db("doc").ref("evidencias/r1").set({ version: 2 }));
  await assertFails(db("doc").ref("estudiantes/ABCD").set({ nombre: "X", grupo: "6.1", llegadasTarde: 0 }));
});

test("directivo y admin: revisan excusas pero no pueden escribir metadatos de evidencias", async () => {
  for (const uid of ["dir", "adm"]) {
    await assertSucceeds(db(uid).ref("registros/r1/justificacion").set(justification(uid)));
    await assertSucceeds(db(uid).ref("registros/r1/justificacion").remove());
    await assertSucceeds(db(uid).ref("evidencias").once("value"));
    await assertFails(db(uid).ref("evidencias/r1").set({ version: 9 }));
    await assertFails(db(uid).ref("evidencias/r1").remove());
  }
});

test("cuenta inactiva no lee nada del panel", async () => {
  await assertFails(db("off").ref("registros").once("value"));
  await assertFails(db("off").ref("evidencias").once("value"));
  await assertFails(db("off").ref("faltas").once("value"));
  await assertFails(db("off").ref("registros/r1/justificacion").set(justification("off")));
});

const falta = (uid) => ({
  uid: "5AD56CAD1D4187", nombre: "Ñusta Ibáñez", grupo: "6.1", fecha: "2026-10-05", justificacion: justification(uid)
});

test("faltas: todos leen; sólo directivo y admin guardan o quitan excusas", async () => {
  const path = "faltas/2026-10-05_5AD56CAD1D4187";
  await assertSucceeds(db("doc").ref("faltas").once("value"));
  await assertFails(db(null).ref("faltas").once("value"));
  await assertFails(db("doc").ref(path).set(falta("doc")));
  for (const uid of ["dir", "adm"]) {
    await assertSucceeds(db(uid).ref(path).set(falta(uid)));
    await assertSucceeds(db(uid).ref(path).remove());
  }
});

const periodo = (uid) => ({ desde: "2026-10-05", hasta: "2026-10-09", motivo: "Semana de receso", creadoPorUid: uid, creadoEn: 1 });

test("días sin clases: todos los leen (también el lector sin sesión); sólo directivo y admin los marcan", async () => {
  await assertSucceeds(db(null).ref("config/diasSinClases").once("value"));
  await assertSucceeds(db("doc").ref("config/diasSinClases").once("value"));
  await assertFails(db(null).ref("config/diasSinClases/p1").set(periodo("x")));
  await assertFails(db("doc").ref("config/diasSinClases/p1").set(periodo("doc")));
  for (const uid of ["dir", "adm"]) {
    await assertSucceeds(db(uid).ref("config/diasSinClases/p1").set(periodo(uid)));
    await assertSucceeds(db(uid).ref("config/diasSinClases/p1").remove());
  }
  await assertFails(db("dir").ref("config/diasSinClases/p2").set({ ...periodo("dir"), hasta: "2026-10-01" }));
  await assertFails(db("dir").ref("config/diasSinClases/p2").set({ ...periodo("dir"), extra: 1 }));
  await assertSucceeds(db("dir").ref("config/diasSinClases/p3").set({ ...periodo("dir"), grupos: "todos" }));
  await assertSucceeds(db("dir").ref("config/diasSinClases/p4").set({ ...periodo("dir"), grupos: "6.1,10.2,11.3" }));
  await assertFails(db("dir").ref("config/diasSinClases/p5").set({ ...periodo("dir"), grupos: "12.1" }));
  await assertFails(db("dir").ref("config/diasSinClases/p6").set({ ...periodo("dir"), grupos: "6.1;6.2" }));
});

test("faltas: la clave debe ser fecha_uid y la excusa debe quedar a nombre de quien la revisa", async () => {
  await assertFails(db("dir").ref("faltas/otra-clave").set(falta("dir")));
  await assertFails(db("dir").ref("faltas/2026-10-05_5AD56CAD1D4187").set(falta("adm")));
  await assertFails(db("dir").ref("faltas/2026-10-05_5AD56CAD1D4187").set({ ...falta("dir"), extra: true }));
});
