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
        off: { nombre: "Inactivo", rol: "directivo", activo: false }
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

test("lector Android sin sesión: lee la ficha, crea el registro e incrementa en uno", async () => {
  await assertSucceeds(db(null).ref("estudiantes/5AD56CAD1D4187").once("value"));
  await assertSucceeds(db(null).ref("config/franjas").once("value"));
  await assertSucceeds(db(null).ref("registros/nuevo").set(newRecord));
  await assertSucceeds(db(null).ref("estudiantes/5AD56CAD1D4187/llegadasTarde").set(2));
  await assertFails(db(null).ref("estudiantes/5AD56CAD1D4187/llegadasTarde").set(10));
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
  await assertFails(db("off").ref("registros/r1/justificacion").set(justification("off")));
});
