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
