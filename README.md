# IERUU · Panel web de maestros

Panel web sencillo para consultar estudiantes por grupo, el total acumulado de tardanzas y las fechas registradas de llegada tarde.

## Uso local

1. Abre `index.html` en un navegador, o utiliza la extensión **Live Server** de VS Code.
2. La web consulta directamente esta Realtime Database: `https://ieruu-asistencia-default-rtdb.firebaseio.com`.
3. Para que funcione durante esta beta, las reglas actuales deben permitir lectura pública:

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

No requiere `google-services.json`: el panel usa la API REST de Realtime Database y no hay autenticación en esta versión.

## Datos que muestra

- Todos los estudiantes de `/estudiantes`, ordenados y separados por `grupo`.
- El valor de `llegadasTarde` de cada estudiante.
- Cada registro de `/registros` que tenga `tarde: true`, ordenado por fecha y hora.

La web se actualiza al abrirla, al pulsar **Actualizar** y cada minuto.

## Importante antes de publicar

Estas reglas públicas exponen nombres, grupos y asistencia. Antes de publicar esta web en Internet hay que añadir Firebase Authentication, restringir las reglas a profesores autorizados y usar una configuración de producción.
