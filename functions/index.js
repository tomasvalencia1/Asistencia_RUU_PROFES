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

/*
 * ---------------------------------------------------------------------------
 * Fotos de evidencia de las excusas.
 *
 * Son datos de menores y pueden ser documentos médicos, así que:
 *   - Las reglas de Storage (storage.rules) niegan TODO acceso directo desde
 *     el navegador. Sólo esta función, con Firebase Admin, lee y escribe.
 *   - Cada llamada consulta /usuarios/<uid> en Realtime Database: si la cuenta
 *     se desactiva, pierde el acceso de inmediato (no depende de claims que
 *     tardan hasta una hora en expirar).
 *   - No se crean URL públicas ni tokens de descarga: la imagen viaja dentro
 *     de la respuesta de la función y el navegador la muestra desde memoria.
 *   - El navegador recomprime la foto (lo que además elimina metadatos EXIF
 *     como la ubicación GPS); aquí se vuelve a validar tipo y tamaño.
 *
 * Archivos: evidencias/<registroId>/<version>.jpg y <version>_mini.jpg
 * Metadatos: /evidencias/<registroId> en Realtime Database (sólo lectura
 * para el personal activo; únicamente esta función escribe).
 * ---------------------------------------------------------------------------
 */

// Quién puede VER las fotos. Para restringirlas a directivos y administradores,
// quita "docente" aquí y en la regla /evidencias de database.rules.json.
const EVIDENCE_VIEW_ROLES = new Set(["docente", "directivo", "admin"]);
// Quién puede subir, reemplazar o quitar fotos: los mismos que revisan excusas.
const EVIDENCE_EDIT_ROLES = new Set(["directivo", "admin"]);
const MAX_IMAGE_BYTES = 1500000;
const MAX_THUMB_BYTES = 120000;
const RECORD_ID_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/;

async function requireStaff(request, allowedRoles, deniedMessage) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }
  const snapshot = await database.ref("usuarios/" + request.auth.uid).once("value");
  const profile = snapshot.val();
  if (!profile || profile.activo !== true || !allowedRoles.has(profile.rol)) {
    throw new HttpsError("permission-denied", deniedMessage);
  }
  return { uid: request.auth.uid, profile };
}

function recordId(value) {
  const id = cleanText(value);
  if (!RECORD_ID_PATTERN.test(id)) {
    throw new HttpsError("invalid-argument", "El identificador de la llegada tarde no es válido.");
  }
  return id;
}

function jpegFromBase64(value, maximum, label) {
  if (typeof value !== "string" || !value || value.length > Math.ceil(maximum / 3) * 4 + 8) {
    throw new HttpsError("invalid-argument", label + " supera el tamaño permitido o está vacía.");
  }
  const buffer = Buffer.from(value, "base64");
  const isJpeg = buffer.length > 4 &&
    buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff &&
    buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
  if (!isJpeg || buffer.length > maximum) {
    throw new HttpsError("invalid-argument", label + " debe ser una imagen JPEG de máximo " + Math.round(maximum / 1000) + " KB.");
  }
  return buffer;
}

function dimension(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 8000 ? number : null;
}

function evidencePaths(id, version) {
  const base = "evidencias/" + id + "/" + String(version);
  return { completa: base + ".jpg", mini: base + "_mini.jpg" };
}

exports.evidencias = onCall({ cors: true, memory: "256MiB", timeoutSeconds: 60 }, async (request) => {
  const data = request.data || {};
  const action = cleanText(data.action);
  const id = recordId(data.registroId);
  const bucket = admin.storage().bucket();
  const metaRef = database.ref("evidencias/" + id);

  if (action === "get") {
    await requireStaff(request, EVIDENCE_VIEW_ROLES, "Tu cuenta no tiene acceso a las fotos de evidencia.");
    const meta = (await metaRef.once("value")).val();
    if (!meta || !Number.isFinite(Number(meta.version))) {
      throw new HttpsError("not-found", "Esta llegada tarde no tiene foto de evidencia.");
    }
    const size = cleanText(data.tamano) === "completa" ? "completa" : "mini";
    try {
      const [contents] = await bucket.file(evidencePaths(id, meta.version)[size]).download();
      return { imagen: contents.toString("base64"), tipo: "image/jpeg", version: meta.version };
    } catch (error) {
      if (error && error.code === 404) {
        throw new HttpsError("not-found", "No se encontró el archivo de la foto.");
      }
      throw error;
    }
  }

  if (action === "upload") {
    const caller = await requireStaff(request, EVIDENCE_EDIT_ROLES, "Sólo directivos y administradores activos pueden adjuntar fotos.");
    const image = jpegFromBase64(data.imagen, MAX_IMAGE_BYTES, "La foto");
    const thumbnail = jpegFromBase64(data.miniatura, MAX_THUMB_BYTES, "La miniatura");

    const record = (await database.ref("registros/" + id).once("value")).val();
    if (!record) {
      throw new HttpsError("not-found", "No se encontró esa llegada tarde.");
    }
    if (record.tarde !== true || !record.justificacion) {
      throw new HttpsError("failed-precondition", "Primero guarda la excusa; luego adjunta la foto.");
    }

    const previous = (await metaRef.once("value")).val();
    const version = Date.now();
    const paths = evidencePaths(id, version);
    const options = (kind) => ({
      resumable: false,
      contentType: "image/jpeg",
      metadata: {
        cacheControl: "private, no-store",
        metadata: { registroId: id, tamano: kind, subidaPorUid: caller.uid }
      }
    });
    await bucket.file(paths.completa).save(image, options("completa"));
    await bucket.file(paths.mini).save(thumbnail, options("mini"));

    const meta = {
      version,
      bytes: image.length,
      subidaPorUid: caller.uid,
      subidaEn: version
    };
    const width = dimension(data.ancho);
    const height = dimension(data.alto);
    if (width && height) {
      meta.ancho = width;
      meta.alto = height;
    }
    await metaRef.set(meta);

    // La versión anterior se borra después de publicar la nueva: si algo falla
    // a mitad de camino, la foto vigente nunca queda rota.
    if (previous && previous.version && previous.version !== version) {
      const old = evidencePaths(id, previous.version);
      await Promise.all([old.completa, old.mini].map((path) => bucket.file(path).delete({ ignoreNotFound: true })))
        .catch((error) => console.warn("No se pudo borrar la versión anterior de la evidencia", id, error));
    }
    return { version };
  }

  if (action === "delete") {
    await requireStaff(request, EVIDENCE_EDIT_ROLES, "Sólo directivos y administradores activos pueden quitar fotos.");
    await bucket.deleteFiles({ prefix: "evidencias/" + id + "/" });
    await metaRef.remove();
    return { deleted: id };
  }

  throw new HttpsError("invalid-argument", "La operación solicitada no es válida.");
});
