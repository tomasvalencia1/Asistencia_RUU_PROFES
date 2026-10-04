/*
 * Fotos de evidencia de las excusas (lado del navegador).
 *
 * - Preparación: decodifica la imagen (JPG, PNG, WEBP y HEIC cuando el
 *   navegador puede leerlo, como Safari en iPhone), corrige la orientación,
 *   la reduce a 1600 px y la recomprime a JPEG. Al recomprimir se descartan
 *   los metadatos EXIF (ubicación GPS, modelo del teléfono…).
 * - Transporte: siempre a través de la Cloud Function `evidencias`. No hay
 *   URL públicas: la imagen llega como datos y se muestra con una URL local
 *   del navegador (blob:) que se revoca al cerrar sesión.
 */

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const FULL_MAX_SIDE = 1600;
const FULL_TARGET_BYTES = 900 * 1024;
const FULL_HARD_LIMIT = 1400 * 1024;
const THUMB_MAX_SIDE = 240;
const THUMB_LIMIT = 100 * 1024;
const ACCEPTED_EXTENSIONS = /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i;
const HEIC_PATTERN = /(\.hei[cf]$)|(image\/hei[cf])/i;

export class EvidenceError extends Error {}

function isHeic(file) {
  return HEIC_PATTERN.test(file.name || "") || HEIC_PATTERN.test(file.type || "");
}

export function validateFile(file) {
  if (!file) throw new EvidenceError("No se seleccionó ningún archivo.");
  const looksLikeImage = (file.type && file.type.startsWith("image/")) || ACCEPTED_EXTENSIONS.test(file.name || "");
  if (!looksLikeImage) {
    throw new EvidenceError("Ese archivo no es una imagen. Usa una foto (JPG, PNG, WEBP o HEIC). Si la excusa es un PDF, tómale una foto o una captura de pantalla.");
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new EvidenceError("La imagen pesa más de 25 MB. Toma la foto de nuevo o envíala en menor calidad.");
  }
}

async function decode(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (error) {
      // Algunos navegadores no aceptan la opción; se intenta con <img>.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function sourceSize(source) {
  return {
    width: source.naturalWidth || source.width,
    height: source.naturalHeight || source.height
  };
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new EvidenceError("No se pudo comprimir la imagen."))), "image/jpeg", quality);
  });
}

async function render(source, maxSide, targetBytes, hardLimit) {
  const { width, height } = sourceSize(source);
  let scale = Math.min(1, maxSide / Math.max(width, height));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    // Fondo blanco: las zonas transparentes de un PNG no quedan negras en JPEG.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, canvas.width, canvas.height);

    for (const quality of [0.82, 0.72, 0.62, 0.52]) {
      const blob = await canvasToBlob(canvas, quality);
      if (blob.size <= targetBytes || (quality === 0.52 && blob.size <= hardLimit)) {
        return { blob, width: canvas.width, height: canvas.height };
      }
    }
    scale *= 0.75;
  }
  throw new EvidenceError("No fue posible reducir la imagen a un tamaño aceptable.");
}

/* Devuelve { full, mini, width, height } listos para subir. */
export async function prepareImage(file) {
  validateFile(file);
  let source;
  try {
    source = await decode(file);
  } catch (error) {
    if (isHeic(file)) {
      throw new EvidenceError(
        "Este navegador no puede abrir fotos HEIC del iPhone. Súbela desde el iPhone con “Tomar foto” o “Elegir archivo” " +
        "(Safari la convierte automáticamente), o en el iPhone ve a Ajustes › Cámara › Formatos y elige “Más compatible”."
      );
    }
    throw new EvidenceError("No se pudo leer la imagen. Puede estar dañada o en un formato no compatible.");
  }
  try {
    const full = await render(source, FULL_MAX_SIDE, FULL_TARGET_BYTES, FULL_HARD_LIMIT);
    const mini = await render(source, THUMB_MAX_SIDE, THUMB_LIMIT * 0.6, THUMB_LIMIT);
    return { full: full.blob, mini: mini.blob, width: full.width, height: full.height };
  } finally {
    if (typeof source.close === "function") source.close();
  }
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, type) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}

export function formatBytes(bytes) {
  return bytes >= 1024 * 1024
    ? (bytes / 1024 / 1024).toFixed(1).replace(".", ",") + " MB"
    : Math.max(1, Math.round(bytes / 1024)) + " KB";
}

export function evidenceErrorMessage(error) {
  if (error instanceof EvidenceError) return error.message;
  const code = String((error && error.code) || "");
  if (code === "functions/permission-denied") return "Tu cuenta no tiene permiso para esta acción con fotos de evidencia.";
  if (code === "functions/unauthenticated") return "Tu sesión expiró. Vuelve a iniciar sesión.";
  if (code === "functions/failed-precondition" || code === "functions/invalid-argument") {
    return (error && error.message) || "La foto no cumple los requisitos.";
  }
  if (code === "functions/not-found") return (error && error.message) || "No se encontró la foto.";
  if (code === "functions/deadline-exceeded" || code === "functions/unavailable" || code === "functions/internal") {
    return "La conexión falló o es muy lenta. Revisa Internet e inténtalo de nuevo.";
  }
  return "No fue posible completar la operación con la foto. Inténtalo de nuevo.";
}

/*
 * Cliente de la Cloud Function con caché en memoria por versión. Las URL
 * blob: sólo existen en esta pestaña y se revocan con clear().
 */
export function createEvidenceClient(callable) {
  const cache = new Map();

  function load(recordId, version, size) {
    const key = recordId + ":" + version + ":" + size;
    if (!cache.has(key)) {
      const promise = callable({ action: "get", registroId: recordId, tamano: size })
        .then((response) => URL.createObjectURL(base64ToBlob(response.data.imagen, response.data.tipo || "image/jpeg")))
        .catch((error) => {
          cache.delete(key);
          throw error;
        });
      cache.set(key, promise);
    }
    return cache.get(key);
  }

  async function upload(recordId, prepared) {
    const [imagen, miniatura] = await Promise.all([blobToBase64(prepared.full), blobToBase64(prepared.mini)]);
    const response = await callable({
      action: "upload",
      registroId: recordId,
      imagen,
      miniatura,
      ancho: prepared.width,
      alto: prepared.height
    });
    return response.data;
  }

  async function remove(recordId) {
    await callable({ action: "delete", registroId: recordId });
  }

  function clear() {
    cache.forEach((promise) => promise.then((url) => URL.revokeObjectURL(url), () => undefined));
    cache.clear();
  }

  return { load, upload, remove, clear };
}

/*
 * Miniaturas perezosas: sólo se piden cuando la miniatura entra en pantalla
 * (los meses plegados no generan llamadas).
 */
export function createThumbnailLoader(client) {
  const observer = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          fill(entry.target);
        }
      });
    }, { rootMargin: "200px" })
    : null;

  function fill(button) {
    const image = button.querySelector("img");
    button.dataset.state = "loading";
    client.load(button.dataset.recordId, button.dataset.version, "mini")
      .then((url) => {
        if (!button.isConnected) return;
        image.src = url;
        button.dataset.state = "ready";
      })
      .catch((error) => {
        console.error("No fue posible cargar la miniatura", error);
        if (!button.isConnected) return;
        button.dataset.state = "error";
        button.title = evidenceErrorMessage(error) + " Toca para reintentar.";
      });
  }

  function observe(button) {
    if (observer) observer.observe(button);
    else fill(button);
  }

  return { observe, fill };
}
