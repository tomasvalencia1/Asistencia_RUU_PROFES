# IERUU · Panel web de docentes

Panel web para consultar en vivo los estudiantes y las llegadas tarde que registra la aplicación NFC.

## Qué incluye

- 18 pestañas fijas: 6.1 a 11.3.
- Cada estudiante aparece automáticamente en su pestaña cuando se agrega en Firebase.
- Tardanzas separadas por mes, con fecha y hora exactas.
- Inicio de sesión con correo y contraseña de Firebase.
- Tres roles reales:

| Rol | Puede ver | Puede añadir/quitar estudiantes | Puede revisar excusas |
| --- | --- | --- | --- |
| Docente | Todo el panel, el motivo y estado de las excusas | No | No |
| Directivo | Todo el panel | Sí | Sí |
| Administrador | Todo el panel | Sí | Sí, y administrar las cuentas de personal |

Además, los tres roles pueden abrir **Estadísticas y Excel** y ver las fotos de evidencia; sólo directivo y administrador pueden adjuntar, reemplazar o quitar fotos (ver la sección [Funciones añadidas en octubre de 2026](#funciones-añadidas-en-octubre-de-2026)).

Los botones se ocultan para docentes y las reglas de Realtime Database también bloquean las escrituras aunque alguien intente usar las herramientas del navegador. El aviso verde muestra siempre el rol que inició sesión. Al iniciar sesión, la pantalla de acceso se oculta por completo.

Al quitar un estudiante se borra solamente su ficha de estudiantes. Sus tardanzas históricas permanecen visibles en los registros existentes.

## Preparación única en Firebase

### 1. Crear o registrar la aplicación web

En Firebase Console abre Configuración del proyecto, sección Tus aplicaciones, y añade una aplicación web. Copia el objeto de configuración que Firebase muestre y reemplaza el contenido de firebase-config.js. Los valores actuales apuntan al proyecto IERUU y sirven como base, pero una configuración propia de aplicación web es la opción recomendada para publicar el panel.

### 2. Activar cuentas de personal y el primer administrador

1. En Firebase Console abre Authentication, Sign-in method.
2. Activa Email/Password.
3. En Users crea al menos la primera cuenta de administrador.
4. Copia su UID.

### 3. Asignar los roles

En Realtime Database crea un nodo llamado usuarios. Dentro crea una clave por cada UID copiado, por ejemplo:

    {
      "usuarios": {
        "UID_DE_FIREBASE_DEL_DOCENTE": {
          "nombre": "Ana Gómez",
          "rol": "docente",
          "activo": true
        },
        "UID_DE_FIREBASE_DEL_DIRECTIVO": {
          "nombre": "Carlos Ruiz",
          "rol": "directivo",
          "activo": true
        },
        "UID_DE_FIREBASE_DEL_ADMIN": {
          "nombre": "María Pérez",
          "rol": "admin",
          "activo": true
        }
      }
    }

Los únicos valores válidos de rol son docente, directivo y admin. Crea primero este administrador desde Firebase Console. Después de publicar la función del paso siguiente, ese administrador podrá crear, editar, desactivar o quitar las demás cuentas desde el botón **Administrar usuarios** del panel.

### 4. Publicar la función de administración de usuarios

La web no puede administrar contraseñas directamente: sería inseguro exponer esos permisos en Vercel o en el navegador. La carpeta `functions` incluye una Firebase Cloud Function llamada `manageUsers`; allí se gestionan las cuentas con Firebase Admin.

1. Instala la Firebase CLI e inicia sesión con la cuenta propietaria del proyecto:

       npm install -g firebase-tools
       firebase login

2. Desde la carpeta `IERUU-MaestrosWeb`, publica sólo la función:

       firebase deploy --only functions:manageUsers

3. Acepta la habilitación de Cloud Functions si Firebase la solicita. Normalmente requiere el plan Blaze, aunque el uso pequeño de esta beta suele mantenerse dentro de la cuota gratuita.
4. Publica la web actualizada en Vercel como lo haces normalmente.

Una vez publicada, inicia sesión con el administrador. En la esquina superior aparecerá **Administrar usuarios**. Desde ese cuadro puedes crear correo, contraseña, rol y estado; editar correo, rol o contraseña; y quitar cuentas. Las contraseñas nunca se guardan ni se muestran en Realtime Database.

### 5. Corregir los datos anteriores antes de activar las reglas

Los grupos nuevos deben guardarse siempre como texto: 6.1, 6.2, 6.3, hasta 11.3.

En el dato de prueba que ya existe, cambia:

    grupo: 102
    tarde: 0

por:

    grupo: "10.2"
    llegadasTarde: 0

No dejes el campo antiguo tarde dentro de estudiantes. El campo tarde pertenece a cada elemento de registros, no a la ficha del estudiante.

La franja que lee la app Android debe tener exactamente esta forma:

    {
      "config": {
        "franjas": {
          "entrada": {
            "horaLimite": "07:00:00"
          }
        }
      }
    }

Luego puedes añadir descanso1 y descanso2 con la misma estructura. La app NFC los lee dinámicamente.

### 6. Publicar las reglas

1. Haz primero una exportación de respaldo de Realtime Database.
2. Abre Realtime Database, pestaña Rules.
3. Copia el contenido de database.rules.json, pégalo y pulsa Publish.

Estas reglas dejan al lector Android actual funcionando durante la beta: puede leer directamente una ficha por UID, crear un registro nuevo e incrementar llegadasTarde exactamente en uno. El panel web sí exige una cuenta activa y aplica los roles.

Importante: mientras el lector Android no tenga inicio de sesión, esa excepción sigue siendo una medida temporal. Alguien con conocimientos técnicos y un UID conocido podría intentar fabricar un registro. Para producción se debe autenticar el lector con una cuenta técnica restringida o enviar la lectura a una Cloud Function; nunca se debe poner una contraseña administrativa ni una clave de servicio dentro del APK.

## Ejecutar la web

No abras index.html con doble clic ni mediante file://. Usa un servidor local:

1. En VS Code instala y usa la extensión Live Server, o abre una terminal dentro de esta carpeta.
2. Ejecuta:

       python -m http.server 8080

3. Si el proyecto no lo tiene ya, añade localhost en Authentication, Settings, Authorized domains. Los proyectos Firebase creados después del 28 de abril de 2025 no lo incluyen automáticamente.
4. Abre http://localhost:8080 en el navegador.
5. Inicia sesión con una de las cuentas creadas.

Para publicar, sube estos archivos a Firebase Hosting, Netlify, GitHub Pages o un servidor HTTPS. Si usas otro dominio, añádelo en Authentication, Settings, Authorized domains.

## Prueba recomendada

1. Inicia sesión con una cuenta docente: debe poder ver grupos, tardanzas, motivos y estados, sin botones de modificación.
2. Inicia sesión con una cuenta directivo: debe aparecer Añadir estudiante, Quitar estudiante y Validar excusa.
3. Agrega una ficha de prueba al grupo 6.1 y comprueba que aparece al instante en su pestaña.
4. Acerca su tarjeta al lector Android y confirma que la tardanza aparece en el mes correspondiente.
5. Valida o rechaza la excusa y vuelve a entrar con una cuenta docente para confirmar que sólo puede leerla.
6. Inicia sesión con el administrador y abre **Administrar usuarios**. Crea una cuenta docente de prueba, edítala, y confirma que un docente no ve ese botón.

## Estructura nueva de una justificación

Cada llegada tarde puede contener este campo opcional:

    {
      "justificacion": {
        "estado": "validada",
        "motivo": "Cita médica",
        "revisadaPorUid": "UID_DEL_DIRECTIVO",
        "revisadaEn": 1758099400000
      }
    }

El panel crea, edita o quita este campo sólo para los roles directivo y admin.


## Funciones añadidas en octubre de 2026

### Estadísticas y Excel (todos los roles)

El botón **Estadísticas y Excel**, junto a «Actualizar», abre una consulta de llegadas tarde:

- **Periodo:** Hoy, Esta semana, Este mes, Mes anterior, Otro día, Otra semana y Otro mes.
- **Filtros combinables:** grupo, franja (entrada, descanso 1, descanso 2 y cualquier otra que aparezca en los datos), estado de la excusa (sin excusa, pendiente, validada, rechazada) y nombre del estudiante (sin importar tildes ni mayúsculas).
- **Resultados:** total de llegadas tarde, estudiantes distintos, sin excusa y validadas; tabla por grupo, y listado con fecha, hora, estudiante, grupo, franja y estado. En el teléfono la consulta ocupa toda la pantalla.
- **Descargar Excel (.xlsx):** descarga exactamente lo que se ve en pantalla (mismo periodo y mismos filtros). El archivo trae una hoja **Resumen** (periodo, filtros, quién y cuándo lo generó, y el desglose por grupo) y una hoja **Detalle** (fecha, hora, estudiante, grupo, franja, estado de la excusa, motivo, si tiene foto, UID de la tarjeta y una observación cuando el estudiante ya no figura en la lista). Fechas y horas son valores reales de Excel; el grupo se guarda como texto para que «10.2» no se convierta en número.

Reglas de cálculo:

- **Zona horaria:** siempre America/Bogota, sin importar la configuración del computador o del celular.
- **Semana:** de lunes a domingo.
- **Día de cada llegada tarde:** el campo `fecha` que escribe el lector Android. Si faltara, se usa `timestamp` convertido a hora de Colombia.
- **Qué se cuenta:** los registros con `tarde: true` y UID válido (el mismo criterio del panel). También se cuentan las llegadas tarde de estudiantes que ya fueron retirados de la lista, marcadas como tales; por eso el total de la consulta puede ser mayor que la tarjeta «Tardanzas registradas», que sólo suma a los estudiantes actuales.
- **Grupo:** el que quedó guardado en el registro al momento de la llegada tarde (los datos antiguos como `102` se leen como `10.2`). Si no es válido, se usa el grupo actual del estudiante; si tampoco hay, aparece como «Sin grupo».
- **Lecturas de Firebase:** la consulta no hace lecturas nuevas. Usa los datos que el panel ya tiene cargados, así que cada rol ve exactamente lo que ya podía leer.

### Fotos de evidencia en las excusas

- **Quién:** directivo y administrador adjuntan, reemplazan o quitan la foto desde el mismo cuadro donde validan la excusa, igual que hoy son los únicos que revisan excusas. Docente, directivo y administrador **ven** la foto: miniatura al lado de la excusa que se amplía al tocarla.
- **Cómo se adjunta:** en el celular, con «Tomar foto» (abre la cámara trasera) o «Elegir archivo» (galería); en el computador, con «Elegir archivo» o arrastrando la imagen al recuadro. La foto se sube al pulsar «Guardar revisión». Si la excusa aún no existía, se guardan juntas.
- **Preparación en el navegador:** corrige la orientación, reduce a máximo 1600 px, recomprime a JPEG (normalmente menos de 900 KB) y descarta los metadatos de la foto, incluida la ubicación GPS. Se aceptan JPG, PNG, WEBP y HEIC cuando el navegador puede abrirlo (Safari en iPhone convierte HEIC automáticamente). Los PDF y las imágenes de más de 25 MB se rechazan con un mensaje claro.
- **Errores:** si la subida falla, la excusa queda guardada, el cuadro sigue abierto y aparece **Reintentar subida**.
- **Privacidad:** las imágenes están en Cloud Storage **sin ningún acceso directo** (las reglas de `storage.rules` lo niegan todo) y sin URL públicas. Sólo la Cloud Function `evidencias` las lee o escribe, y en cada solicitud comprueba en `/usuarios` que la cuenta esté activa y tenga el rol adecuado. Una cuenta desactivada pierde el acceso de inmediato. Al cerrar sesión, el navegador borra de la memoria las imágenes que había mostrado.
- **Quitar la excusa** borra primero su foto.

Para que sólo directivos y administradores vean las fotos, quita `"docente"` en `EVIDENCE_VIEW_ROLES` (`functions/index.js`) y la condición de docente en la regla `evidencias` de `database.rules.json`; luego vuelve a publicar ambas cosas.

### Datos nuevos (retrocompatibles)

Ni `/registros` ni `/estudiantes` cambian de forma, y el lector Android no se toca.

    evidencias/<id del registro>          (Realtime Database, sólo metadatos)
      version: 1791029400000              (número; también es la fecha de subida en milisegundos)
      bytes: 512345
      ancho: 1200, alto: 1600             (opcionales)
      subidaPorUid: "<uid del directivo>"
      subidaEn: 1791029400000

    evidencias/<id del registro>/<version>.jpg        (Cloud Storage, foto)
    evidencias/<id del registro>/<version>_mini.jpg   (Cloud Storage, miniatura de 240 px)

Sólo la Cloud Function escribe en ambos lugares. Las reglas de `/registros` sólo ganan `.indexOn: ["fecha", "timestamp"]`, que no cambia ningún permiso.

## Pasos manuales para activar las funciones nuevas

**Estadísticas y Excel funcionan apenas se publique la web en Vercel; no requieren nada en Firebase.** Los pasos siguientes son para las fotos de evidencia y para que «Administrar usuarios» funcione (hoy su función no está publicada).

### A. Antes de empezar

1. **Respaldo.** En Firebase Console abre Realtime Database, pulsa el menú ⋮ y elige **Exportar JSON**. Guarda el archivo.
2. **Compara las reglas.** En Realtime Database, pestaña **Reglas**, verifica que lo publicado sea igual al `database.rules.json` anterior de este repositorio. Si alguien hizo cambios directamente en la consola, cópialos antes de seguir, porque el paso C los reemplaza.

### B. Plan Blaze y Cloud Storage (una sola vez)

3. En Firebase Console pulsa el engranaje ⚙ › **Uso y facturación** › **Detalles y configuración** › **Modificar plan** y elige **Blaze**. Se requiere una cuenta de facturación con tarjeta. Es obligatorio por dos razones: los buckets `*.firebasestorage.app` sólo funcionan en Blaze, y las Cloud Functions también lo exigen.
4. **Pon un tope de alerta.** En Google Cloud Console abre **Facturación › Presupuestos y alertas** y crea un presupuesto de, por ejemplo, USD 5 al mes, con avisos por correo. El uso esperado del colegio cabe en la capa gratuita, pero así te enteras si algo cambia.
5. En Firebase Console abre **Storage** y pulsa **Comenzar**. Elige **modo de producción** y la ubicación **US-CENTRAL1**, que entra en la capa gratuita de Cloud Storage (5 GB y 100 GB de transferencia al mes). La ubicación no se puede cambiar después.

### C. Publicar reglas y funciones con la Firebase CLI

6. Instala **Node.js 22 LTS** desde https://nodejs.org (en Windows, el instalador `.msi`). Abre una terminal y comprueba con `node -v`.
7. Instala la CLI e inicia sesión con la cuenta propietaria del proyecto:

       npm install -g firebase-tools
       firebase login

8. En la terminal, entra a la carpeta del repositorio (la que contiene `firebase.json`) e instala las dependencias de las funciones:

       cd functions
       npm install
       cd ..

9. Publica las reglas de Realtime Database y de Storage:

       firebase deploy --only database,storage --project ieruu-asistencia

   Si prefieres hacerlo a mano: copia `database.rules.json` en Realtime Database › Reglas y `storage.rules` en Storage › Reglas, y pulsa **Publicar** en cada una.

10. Publica las dos Cloud Functions, `manageUsers` y `evidencias`:

        firebase deploy --only functions --project ieruu-asistencia

    - Si pregunta por habilitar APIs (Cloud Functions, Cloud Build, Artifact Registry, Cloud Run, Eventarc), responde que sí y espera a que termine.
    - Si pregunta por una política de limpieza de imágenes de contenedor, acepta el valor sugerido (1 día). Evita cobros por imágenes viejas.
    - Las funciones usan **Node.js 22**. Node 20 se retira el 30 de octubre de 2026 y después de esa fecha ya no se podrían desplegar.

11. Publica la web en Vercel como de costumbre: confirma los cambios en GitHub y espera el despliegue. No hay paso de compilación. La carpeta `tests` queda fuera por `.vercelignore`.

### D. Configuración opcional

12. Si el lector Android debe aplicar las franjas de descanso, añade en Realtime Database `config/franjas/descanso1/horaLimite: "09:10:00"` y `config/franjas/descanso2/horaLimite: "12:10:00"`. Hoy sólo existe `entrada`.

### E. Comprobación manual (unos 10 minutos)

13. **Docente:** entra y abre **Estadísticas y Excel**. Prueba Hoy, Esta semana y Mes anterior, y descarga el Excel. Comprueba que el total del archivo coincide con la pantalla. No debe ver botones para editar excusas ni subir fotos.
14. **Directivo:** abre una llegada tarde con excusa y pulsa **Editar excusa**. Adjunta una foto desde el celular (cámara) y otra desde el computador (arrastrándola). La miniatura debe aparecer junto a la excusa; al tocarla, se amplía. Reemplázala y luego quítala.
15. **Docente de nuevo:** la miniatura aparece y se amplía, pero no hay botones de edición.
16. **Administrador:** abre **Administrar usuarios**, desactiva una cuenta de prueba y verifica que ya no puede entrar.
17. **Lector Android:** registra una llegada tarde con una tarjeta de prueba. Debe aparecer en el panel y en **Estadísticas › Hoy**.

### Si algo falla

- **«No fue posible completar la operación con la foto»** o la miniatura muestra **Reintentar** de forma permanente: la función `evidencias` no está publicada o falló. Revisa Firebase Console › Functions › Registros.
- **«Permission denied» en los registros de la función:** el proyecto puede pertenecer a una organización de Google Cloud que no da permisos automáticos a la cuenta de servicio predeterminada. En Google Cloud Console › IAM, otorga a `<número del proyecto>-compute@developer.gserviceaccount.com` los roles **Storage Object Admin** y **Firebase Realtime Database Admin**. Para `manageUsers` añade también **Firebase Authentication Admin**.
- **Error de CORS o 403 al llamar la función desde el panel:** una política de la organización puede impedir la invocación pública de Cloud Run. Las funciones `onCall` la necesitan, porque la autenticación la hace Firebase dentro de la función.

## Pruebas automatizadas

Están en la carpeta `tests` y no se publican.

| Prueba | Qué verifica | Cómo ejecutarla |
| --- | --- | --- |
| `query.test.mjs` | Periodos, semana de lunes a domingo, cambio de mes y de año, zona horaria, filtros, tildes y totales | `cd tests && npm run test:query` |
| `functions.test.cjs` | Función `evidencias`: roles, cuenta inactiva, validación de JPEG y tamaño, reemplazo y borrado (Firebase Admin simulado) | Primero `npm install` en `functions`; luego `cd tests && npm run test:functions` |
| `rules.test.mjs` | Reglas de Realtime Database por rol, cuenta inactiva, acceso anónimo y que el lector Android siga escribiendo | `cd tests && npm install && npm run test:rules` (requiere Java 21) |
| `browser/run_ui_tests.py` | Interfaz completa en Chromium con Firebase simulado: los tres roles, móvil y escritorio, Excel abierto con openpyxl y LibreOffice, fotos (EXIF, HEIC, PDF, 25 MB, arrastrar, red lenta y reintento) | `pip install playwright openpyxl pillow`, `python -m playwright install chromium`, y desde la raíz `python tests/browser/run_ui_tests.py` |
