/*
 * Operaciones sensibles de usuarios para IERUU.
 *
 * Este código se ejecuta exclusivamente en Firebase Cloud Functions con
 * Firebase Admin. Las contraseñas nunca se envían a Realtime Database ni se
 * devuelven al navegador. Sólo un perfil /usuarios/<uid> activo con rol admin
 * puede llamar a esta función.
 */

const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

const auth = admin.auth();
const database = admin.database();
const ALLOWED_ROLES = new Set(["docente", "directivo", "admin"]);

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requiredText(value, label, maximum) {
  const result = cleanText(value);
  if (!result || result.length > maximum) {
    throw new HttpsError("invalid-argument", label + " es obligatorio y no puede superar " + maximum + " caracteres.");
  }
  return result;
}

function validEmail(value) {
  const email = cleanText(value).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new HttpsError("invalid-argument", "Escribe un correo institucional válido.");
  }
  return email;
}

function validRole(value) {
  const role = cleanText(value);
  if (!ALLOWED_ROLES.has(role)) {
    throw new HttpsError("invalid-argument", "El rol debe ser docente, directivo o admin.");
  }
  return role;
}

function validActive(value) {
  if (typeof value !== "boolean") {
    throw new HttpsError("invalid-argument", "El estado activo debe ser verdadero o falso.");
  }
  return value;
}

function optionalPassword(value, isRequired) {
  if (value === undefined || value === null || value === "") {
    if (isRequired) {
      throw new HttpsError("invalid-argument", "Escribe una contraseña de mínimo 8 caracteres.");
    }
    return "";
  }
  if (typeof value !== "string" || value.length < 8 || value.length > 4096) {
    throw new HttpsError("invalid-argument", "La contraseña debe tener entre 8 y 4096 caracteres.");
  }
  return value;
}

function userId(value) {
  const uid = cleanText(value);
  if (!uid || uid.length > 128) {
    throw new HttpsError("invalid-argument", "El identificador de usuario no es válido.");
  }
  return uid;
}

async function requireAdmin(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }

  const snapshot = await database.ref("usuarios/" + request.auth.uid).once("value");
  const profile = snapshot.val();
  if (!profile || profile.activo !== true || profile.rol !== "admin") {
    throw new HttpsError("permission-denied", "Sólo un administrador activo puede gestionar usuarios.");
  }
  return { uid: request.auth.uid, profile };
}

function publicUser(userRecord, profile) {
  return {
    uid: userRecord.uid,
    email: userRecord.email || "",
    displayName: userRecord.displayName || "",
    disabled: userRecord.disabled === true,
    profile: profile || null
  };
}

async function listUsers() {
  let pageToken;
  const authUsers = [];
  do {
    const page = await auth.listUsers(1000, pageToken);
    authUsers.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);

  const users = await Promise.all(authUsers.map(async (userRecord) => {
    const snapshot = await database.ref("usuarios/" + userRecord.uid).once("value");
    return publicUser(userRecord, snapshot.val());
  }));
  users.sort((first, second) => (first.email || "").localeCompare(second.email || "", "es"));
  return users;
}

exports.manageUsers = onCall({ cors: true }, async (request) => {
  const caller = await requireAdmin(request);
  const data = request.data || {};
  const action = cleanText(data.action);

  if (action === "list") {
    return { users: await listUsers() };
  }

  if (action === "create") {
    const nombre = requiredText(data.nombre, "El nombre", 80);
    const email = validEmail(data.email);
    const rol = validRole(data.rol);
    const activo = validActive(data.activo);
    const password = optionalPassword(data.password, true);

    let createdUser;
    try {
      createdUser = await auth.createUser({
        email,
        password,
        displayName: nombre,
        disabled: !activo
      });
      await database.ref("usuarios/" + createdUser.uid).set({ nombre, rol, activo });
    } catch (error) {
      // Si el perfil no se pudo escribir, se revierte la cuenta recién creada.
      if (createdUser) await auth.deleteUser(createdUser.uid).catch(() => undefined);
      if (error && error.code === "auth/email-already-exists") {
        throw new HttpsError("already-exists", "Ya existe una cuenta con ese correo.");
      }
      throw error;
    }
    return { user: publicUser(createdUser, { nombre, rol, activo }) };
  }

  if (action === "update") {
    const uid = userId(data.uid);
    const nombre = requiredText(data.nombre, "El nombre", 80);
    const email = validEmail(data.email);
    const rol = validRole(data.rol);
    const activo = validActive(data.activo);
    const password = optionalPassword(data.password, false);

    // Un administrador no puede desactivar, borrar ni quitarse el rol a sí mismo por accidente.
    if (uid === caller.uid && (rol !== "admin" || !activo)) {
      throw new HttpsError("failed-precondition", "No puedes quitarte el rol de administrador ni desactivar tu propia cuenta.");
    }

    const updateData = { email, displayName: nombre, disabled: !activo };
    if (password) updateData.password = password;
    try {
      const updatedUser = await auth.updateUser(uid, updateData);
      await database.ref("usuarios/" + uid).set({ nombre, rol, activo });
      return { user: publicUser(updatedUser, { nombre, rol, activo }) };
    } catch (error) {
      if (error && error.code === "auth/user-not-found") {
        throw new HttpsError("not-found", "No se encontró esa cuenta.");
      }
      if (error && error.code === "auth/email-already-exists") {
        throw new HttpsError("already-exists", "Ya existe una cuenta con ese correo.");
      }
      throw error;
    }
  }

  if (action === "delete") {
    const uid = userId(data.uid);
    if (uid === caller.uid) {
      throw new HttpsError("failed-precondition", "No puedes borrar tu propia cuenta desde esta pantalla.");
    }
    try {
      await auth.deleteUser(uid);
      await database.ref("usuarios/" + uid).remove();
      return { deletedUid: uid };
    } catch (error) {
      if (error && error.code === "auth/user-not-found") {
        throw new HttpsError("not-found", "No se encontró esa cuenta.");
      }
      throw error;
    }
  }

  throw new HttpsError("invalid-argument", "La operación solicitada no es válida.");
});
