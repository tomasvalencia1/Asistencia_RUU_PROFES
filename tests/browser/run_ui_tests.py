"""Arnés de pruebas de interfaz con Playwright (Chromium) y un Firebase simulado.

Uso (desde la raíz del repositorio):
    pip install playwright openpyxl pillow && python -m playwright install chromium
    python tests/browser/run_ui_tests.py

El navegador se ejecuta deliberadamente en la zona horaria Asia/Tokyo para
comprobar que los cálculos usan America/Bogota y no la zona del equipo.
"""
import json
import functools
import http.server
import os
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, str(Path(__file__).parent))
import fixture  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get("UI_TEST_OUT", ROOT / "tests" / "browser" / "out"))
OUT.mkdir(parents=True, exist_ok=True)
MOCK_JS = (Path(__file__).parent / "mock-firebase.js").read_text(encoding="utf-8")
FIXED_NOW = "2026-10-03T15:00:00-05:00"  # sábado 3 de octubre de 2026, 3:00 p. m. en Bogotá
PORT = 8765

RESULTS = []


def check(name, condition, detail=""):
    RESULTS.append((name, bool(condition), detail))
    print(("PASS " if condition else "FAIL ") + name + (f" — {detail}" if detail else ""))


def serve():
    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def init_script(db, uid, extra=""):
    user = {"uid": uid, "email": uid + "@ieruu.test"} if uid else None
    return (
        "window.__MOCK = " + json.dumps({"db": db, "user": user, "loginAs": user, "latencyMs": 30}, ensure_ascii=False) + ";\n"
        + extra
    )


def new_page(browser, db, uid, viewport=None, extra=""):
    context = browser.new_context(
        viewport=viewport or {"width": 1280, "height": 900},
        timezone_id="Asia/Tokyo",
        locale="es-CO",
        accept_downloads=True,
        has_touch=bool(viewport and viewport["width"] < 600),
        is_mobile=bool(viewport and viewport["width"] < 600),
    )
    context.route("https://www.gstatic.com/firebasejs/**", lambda route: route.fulfill(
        status=200, content_type="text/javascript", body=MOCK_JS))
    page = context.new_page()
    page.clock.set_fixed_time(FIXED_NOW)
    page.add_init_script(init_script(db, uid, extra))
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: message.type == "error" and errors.append(message.text))
    page.goto(f"http://127.0.0.1:{PORT}/index.html")
    page.wait_for_selector("#appView:not([hidden])", timeout=15000)
    page.wait_for_function("document.querySelector('#syncStatus').textContent.includes('en vivo')", timeout=15000)
    return context, page, errors


def open_stats(page):
    page.click("#statsButton")
    expect(page.locator("#statsDialog")).to_be_visible()


def pick_period(page, value):
    page.locator(f"#statsDialog label.chip:has(input[value='{value}'])").click()


def stat(page, selector):
    return int(page.locator(selector).inner_text())


def test_stats(browser, db):
    for role_uid in ("uid-docente", "uid-directivo", "uid-admin"):
        context, page, errors = new_page(browser, db, role_uid)
        check(f"[{role_uid}] botón Estadísticas visible", page.locator("#statsButton").is_visible())
        open_stats(page)

        pick_period(page, "hoy")
        check(f"[{role_uid}] Hoy = sábado 3 oct", "sábado, 3 de octubre de 2026" in page.inner_text("#statsRangeLabel").lower(),
              page.inner_text("#statsRangeLabel"))
        check(f"[{role_uid}] Hoy cuenta", stat(page, "#statsTotal") == fixture.expected_count(db, "2026-10-03", "2026-10-03"))

        pick_period(page, "semana")
        expected_week = fixture.expected_count(db, "2026-09-28", "2026-10-04")
        check(f"[{role_uid}] Esta semana (lun 28 sep – dom 4 oct)", stat(page, "#statsTotal") == expected_week,
              f"vista={stat(page, '#statsTotal')} esperado={expected_week}")

        pick_period(page, "mes")
        check(f"[{role_uid}] Este mes", stat(page, "#statsTotal") == fixture.expected_count(db, "2026-10-01", "2026-10-31"))

        pick_period(page, "mes-anterior")
        expected_sep = fixture.expected_count(db, "2026-09-01", "2026-09-30")
        check(f"[{role_uid}] Mes anterior (septiembre)", stat(page, "#statsTotal") == expected_sep)

        page.select_option("#statsGroupInput", "10.2")
        page.select_option("#statsExcuseInput", "validada")
        expected = fixture.expected_count(db, "2026-09-01", "2026-09-30", group="10.2", excuse="validada")
        check(f"[{role_uid}] filtros combinados grupo+excusa", stat(page, "#statsTotal") == expected,
              f"vista={stat(page, '#statsTotal')} esperado={expected}")
        page.click("#statsResetButton")
        check(f"[{role_uid}] limpiar filtros vuelve a Hoy", page.locator("input[value='hoy']").is_checked())
        if errors:
            check(f"[{role_uid}] sin errores de consola", False, "; ".join(errors[:3]))
        context.close()

    context, page, errors = new_page(browser, db, "uid-docente")
    open_stats(page)
    pick_period(page, "mes-de")
    page.select_option("#statsMonthInput", "2026-07")
    check("mes sin datos muestra 0 y mensaje", stat(page, "#statsTotal") == 0
          and "No hay llegadas tarde" in page.inner_text("#statsList"))

    pick_period(page, "semana-de")
    page.fill("#statsWeekInput", "2027-01-01")
    page.dispatch_event("#statsWeekInput", "change")
    label = page.inner_text("#statsRangeLabel")
    check("semana que cruza el año", "28 de diciembre de 2026" in label and "3 de enero de 2027" in label, label)
    check("estudiante retirado se cuenta en la semana del cambio de año", stat(page, "#statsTotal") == 2)
    check("estudiante retirado se marca", "Ya no figura en estudiantes" in page.inner_text("#statsList"))

    pick_period(page, "dia")
    page.fill("#statsDayInput", "2026-10-01")
    page.dispatch_event("#statsDayInput", "change")
    page.fill("#statsNameInput", "nusta ibanez")
    check("búsqueda sin tildes encuentra Ñusta Ibáñez", stat(page, "#statsTotal") == 1
          and "Ñusta Ibáñez Úsuga" in page.inner_text("#statsList"))
    check("franja desconocida aparece en el filtro", page.locator("#statsFranjaInput option[value='otra-franja']").count() == 1)
    page.fill("#statsNameInput", "")

    pick_period(page, "dia")
    page.fill("#statsDayInput", "2026-10-02")
    page.dispatch_event("#statsDayInput", "change")
    page.fill("#statsNameInput", "Legado")
    check("grupo heredado 102 se muestra como 10.2", "Grupo 10.2" in page.inner_text("#statsList"))
    page.fill("#statsNameInput", "")

    # Desglose: la suma por grupo coincide con el total.
    pick_period(page, "mes-anterior")
    page.check("#statsShowEmptyGroups")
    rows = page.locator("#statsGroupTableBody tr").count()
    check("con 'grupos en cero' se listan 18 grupos (+ Sin grupo si aplica)", rows >= 18, str(rows))
    total_from_rows = page.evaluate(
        "[...document.querySelectorAll('#statsGroupTableBody tr')].reduce((s, r) => s + Number(r.children[1].textContent || 0), 0)")
    check("suma del desglose = total", total_from_rows == stat(page, "#statsTotal"))
    check("paginación del listado (200 primeros)", page.locator("#statsList li").count() == 200
          and page.locator("#statsMoreButton").is_visible())
    page.click("#statsMoreButton")
    check("mostrar más amplía a 400", page.locator("#statsList li").count() == min(400, stat(page, "#statsTotal")))
    page.screenshot(path=str(OUT / "stats-desktop.png"), full_page=False)

    # Actualización en vivo: un registro nuevo hoy aparece sin recargar.
    pick_period(page, "hoy")
    before = stat(page, "#statsTotal")
    page.evaluate("""() => {
      window.__mockApi.writePath('registros/-Nlive1', {uid: 'EDGE01', nombre: 'Ñusta Ibáñez Úsuga', grupo: '6.1',
        fecha: '2026-10-03', hora: '12:15:00', timestamp: 1, periodo: 'descanso2', tarde: true});
      window.__mockApi.notify();
    }""")
    page.wait_for_timeout(300)
    check("actualización en vivo dentro de la vista", stat(page, "#statsTotal") == before + 1)
    if errors:
        check("sin errores de consola (docente)", False, "; ".join(errors[:3]))
    context.close()

    # Móvil
    context, page, errors = new_page(browser, db, "uid-docente", viewport={"width": 390, "height": 844})
    check("móvil: botón visible sin desplazamiento horizontal",
          page.locator("#statsButton").is_visible() and page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))
    open_stats(page)
    pick_period(page, "semana")
    box = page.locator("#statsDialog").bounding_box()
    check("móvil: la consulta ocupa la pantalla", box and box["width"] >= 385, str(box))
    overflow = page.evaluate("document.querySelector('#statsDialog').scrollWidth <= document.querySelector('#statsDialog').clientWidth + 1")
    check("móvil: sin desbordamiento horizontal en el diálogo", overflow)
    page.screenshot(path=str(OUT / "stats-mobile.png"), full_page=False)
    context.close()


def download_xlsx(page, name):
    with page.expect_download(timeout=20000) as info:
        page.click("#statsExportButton")
    download = info.value
    target = OUT / name
    download.save_as(str(target))
    return download.suggested_filename, target


def inspect_xlsx(path):
    import openpyxl
    workbook = openpyxl.load_workbook(path)
    summary, detail = workbook["Resumen"], workbook["Detalle"]
    total_row = [row for row in summary.iter_rows(values_only=True) if row and row[0] == "Total"][0]
    detail_rows = [row for row in detail.iter_rows(min_row=2, values_only=True) if row and row[0] is not None]
    return workbook, summary, detail, total_row, detail_rows


def libreoffice_opens(path):
    import subprocess
    import tempfile
    with tempfile.TemporaryDirectory() as folder:
        result = subprocess.run(
            ["soffice", "--headless", "--convert-to", "csv", "--outdir", folder, str(path)],
            capture_output=True, text=True, timeout=120)
        csv_files = list(Path(folder).glob("*.csv"))
        return result.returncode == 0 and bool(csv_files), (csv_files[0].read_text(encoding="utf-8", errors="replace")[:300] if csv_files else result.stderr)


def test_export(browser, db):
    import datetime
    for role_uid in ("uid-docente", "uid-directivo", "uid-admin"):
        context, page, errors = new_page(browser, db, role_uid)
        open_stats(page)
        pick_period(page, "semana")
        view_total = stat(page, "#statsTotal")
        name, path = download_xlsx(page, f"semana-{role_uid}.xlsx")
        check(f"[{role_uid}] nombre del archivo", name == "llegadas-tarde_semana_2026-09-28_a_2026-10-04_generado-2026-10-03.xlsx", name)
        workbook, summary, detail, total_row, rows = inspect_xlsx(path)
        check(f"[{role_uid}] hojas Resumen y Detalle", workbook.sheetnames == ["Resumen", "Detalle"], str(workbook.sheetnames))
        check(f"[{role_uid}] total del Excel = vista", total_row[1] == view_total == len(rows), f"excel={total_row[1]} filas={len(rows)} vista={view_total}")
        if errors:
            check(f"[{role_uid}] sin errores de consola en exportación", False, "; ".join(errors[:3]))
        context.close()

    context, page, errors = new_page(browser, db, "uid-docente")
    open_stats(page)
    pick_period(page, "mes-anterior")
    page.select_option("#statsGroupInput", "6.1")
    view = {key: stat(page, sel) for key, sel in (("total", "#statsTotal"), ("sin", "#statsWithoutExcuse"), ("val", "#statsValidated"), ("est", "#statsStudents"))}
    name, path = download_xlsx(page, "septiembre-6-1.xlsx")
    workbook, summary, detail, total_row, rows = inspect_xlsx(path)
    check("mes anterior + grupo: totales idénticos (total, sin excusa, validadas, estudiantes)",
          (total_row[1], total_row[2], total_row[4], total_row[6]) == (view["total"], view["sin"], view["val"], view["est"]),
          f"excel={total_row} vista={view}")
    check("con filtro de grupo sólo aparece ese grupo en el resumen",
          [row[0] for row in summary.iter_rows(min_row=9, values_only=True) if row and row[0]] == ["Grupo 6.1", "Total"])
    first = rows[0]
    first_view = page.locator("#statsList li").first.inner_text()
    check("fecha es un valor de fecha real", isinstance(first[0], datetime.datetime), repr(first[0]))
    check("hora es un valor de hora real", isinstance(first[1], datetime.time), repr(first[1]))
    check("formato de fecha dd/mm/yyyy", detail["A2"].number_format == "dd/mm/yyyy", detail["A2"].number_format)
    check("primera fila del Excel = primera de la vista",
          first[2] in first_view and first[1].strftime("%H:%M:%S") in first_view, f"{first[:3]} vs {first_view!r}")
    check("grupo como texto, no número", detail["D2"].value == "6.1" and detail["D2"].data_type == "s", repr(detail["D2"].value))
    check("encabezado en negrita", detail["A1"].font.b is True)
    check("primera fila fija (freeze)", detail.freeze_panes == "A2", str(detail.freeze_panes))
    check("ancho de columna razonable", (detail.column_dimensions["C"].width or 0) >= 30)
    check("periodo con tildes en el resumen", summary["B2"].value == "Septiembre de 2026", repr(summary["B2"].value))
    check("rango Desde/Hasta como fechas", summary["B3"].value == datetime.datetime(2026, 9, 1) and summary["B4"].value == datetime.datetime(2026, 9, 30))
    ok, preview = libreoffice_opens(path)
    check("LibreOffice abre el archivo sin error", ok, preview[:120])

    # Nombre con ñ y tildes, día específico.
    pick_period(page, "dia")
    page.fill("#statsDayInput", "2026-10-03")
    page.dispatch_event("#statsDayInput", "change")
    page.select_option("#statsGroupInput", "")
    page.fill("#statsNameInput", "ñusta")
    name, path = download_xlsx(page, "dia-nusta.xlsx")
    workbook, summary, detail, total_row, rows = inspect_xlsx(path)
    check("tildes y ñ intactas", rows and rows[0][2] == "Ñusta Ibáñez Úsuga" and rows[0][6] == "Cita odontológica — acudiente", repr(rows[:1]))
    check("filtro de nombre descrito en el resumen", "ñusta" in summary["B5"].value, summary["B5"].value)

    # Periodo vacío.
    page.fill("#statsNameInput", "")
    pick_period(page, "mes-de")
    page.select_option("#statsMonthInput", "2026-07")
    name, path = download_xlsx(page, "vacio.xlsx")
    workbook, summary, detail, total_row, rows = inspect_xlsx(path)
    check("mes sin datos: archivo válido con total 0", total_row[1] == 0 and name.endswith("mes_2026-07_generado-2026-10-03.xlsx"), name)
    ok, _ = libreoffice_opens(path)
    check("LibreOffice abre el archivo vacío", ok)
    context.close()

    # Fallo de red al cargar la biblioteca y reintento.
    context, page, errors = new_page(browser, db, "uid-docente")
    attempts = {"count": 0}

    def flaky(route):
        attempts["count"] += 1
        if attempts["count"] == 1:
            route.abort()
        else:
            route.continue_()
    page.route("**/vendor/write-excel-file-4.1.1.min.js", flaky)
    open_stats(page)
    page.click("#statsExportButton")
    page.wait_for_function("document.querySelector('#statsExportStatus').classList.contains('error')", timeout=10000)
    check("sin conexión: mensaje de error visible", "No se pudo generar" in page.inner_text("#statsExportStatus"))
    name, path = download_xlsx(page, "reintento.xlsx")
    check("reintento tras fallo de red descarga el archivo", path.exists() and attempts["count"] == 2)
    context.close()

    # Rendimiento con un año escolar grande.
    big = fixture.build(students_count=1200, late_per_day=120, seed=3)
    context, page, errors = new_page(browser, big, "uid-docente")
    open_stats(page)
    started = page.evaluate("performance.now()")
    pick_period(page, "mes-anterior")
    elapsed = page.evaluate(f"performance.now() - {started}")
    name, path = download_xlsx(page, "grande.xlsx")
    workbook, summary, detail, total_row, rows = inspect_xlsx(path)
    check("volumen alto: consulta y exportación correctas", total_row[1] == stat(page, "#statsTotal") == len(rows),
          f"{len(big['registros'])} registros en la base, {len(rows)} en el mes, consulta {elapsed:.0f} ms")
    context.close()


EVIDENCE_MOCK = r"""
window.__MOCK.storage = {};
window.__MOCK.callables = {
  async evidencias(data, ctx) {
    await new Promise((resolve) => setTimeout(resolve, window.__MOCK.functionLatencyMs || 50));
    const fail = (code, message) => { const error = new Error(message); error.code = 'functions/' + code; throw error; };
    if (window.__MOCK.functionDown) fail('internal', 'internal');
    const profile = ctx.user && ctx.db.usuarios[ctx.user.uid];
    if (!profile) fail('unauthenticated', 'Debes iniciar sesión.');
    const canView = profile.activo === true && ['docente', 'directivo', 'admin'].includes(profile.rol);
    const canEdit = profile.activo === true && ['directivo', 'admin'].includes(profile.rol);
    const id = data.registroId;
    const meta = (ctx.db.evidencias || {})[id];
    if (data.action === 'get') {
      if (!canView) fail('permission-denied', 'Sin acceso');
      if (!meta) fail('not-found', 'Esta llegada tarde no tiene foto de evidencia.');
      const file = window.__MOCK.storage[id + '/' + meta.version + (data.tamano === 'completa' ? '' : '_mini')];
      return { imagen: file, tipo: 'image/jpeg', version: meta.version };
    }
    if (data.action === 'upload') {
      if (!canEdit) fail('permission-denied', 'Sólo directivos y administradores activos pueden adjuntar fotos.');
      if (window.__MOCK.failNextUpload) { window.__MOCK.failNextUpload = false; fail('unavailable', 'unavailable'); }
      if (!String(data.imagen).startsWith('/9j/') || !String(data.miniatura).startsWith('/9j/')) fail('invalid-argument', 'No es JPEG');
      if (atob(data.imagen).length > 1500000 || atob(data.miniatura).length > 120000) fail('invalid-argument', 'Demasiado grande');
      const record = ctx.db.registros[id];
      if (!record || !record.justificacion) fail('failed-precondition', 'Primero guarda la excusa; luego adjunta la foto.');
      const version = Date.now() + Math.floor(Math.random() * 1000);
      window.__MOCK.storage[id + '/' + version] = data.imagen;
      window.__MOCK.storage[id + '/' + version + '_mini'] = data.miniatura;
      if (meta) { delete window.__MOCK.storage[id + '/' + meta.version]; delete window.__MOCK.storage[id + '/' + meta.version + '_mini']; }
      ctx.writePath('evidencias/' + id, { version, bytes: atob(data.imagen).length, ancho: data.ancho, alto: data.alto, subidaPorUid: ctx.user.uid, subidaEn: version });
      ctx.notify();
      window.__MOCK.uploads = (window.__MOCK.uploads || 0) + 1;
      return { version };
    }
    if (data.action === 'delete') {
      if (!canEdit) fail('permission-denied', 'Sin permiso');
      Object.keys(window.__MOCK.storage).filter((key) => key.startsWith(id + '/')).forEach((key) => delete window.__MOCK.storage[key]);
      ctx.writePath('evidencias/' + id, null);
      ctx.notify();
      return { deleted: id };
    }
    fail('invalid-argument', 'Operación no válida');
  }
};
"""


def make_images():
    """Genera imágenes de prueba: JPEG grande con EXIF (GPS y orientación), PNG con transparencia, falsos HEIC y PDF."""
    from PIL import Image
    import random
    folder = OUT / "imagenes"
    folder.mkdir(exist_ok=True)
    rng = random.Random(1)
    big = Image.effect_noise((4032, 3024), 90).convert("RGB")
    exif = Image.Exif()
    exif[0x0112] = 6  # Orientación: girar 90° (foto vertical de celular)
    exif[0x010F] = "FakePhone"
    gps = {1: "N", 2: (6.0, 15.0, 0.0), 3: "W", 4: (75.0, 34.0, 0.0)}
    exif[0x8825] = gps
    big.save(folder / "foto-celular.jpg", quality=95, exif=exif.tobytes())
    png = Image.new("RGBA", (900, 600), (0, 0, 0, 0))
    for x in range(0, 900, 3):
        for y in range(0, 600, 50):
            png.putpixel((x, y), (rng.randint(0, 255), 40, 90, 255))
    png.save(folder / "captura.png")
    (folder / "IMG_0001.heic").write_bytes(b"\x00\x00\x00\x18ftypheic" + bytes(5000))
    (folder / "excusa.pdf").write_bytes(b"%PDF-1.7\n" + bytes(3000))
    with open(folder / "enorme.jpg", "wb") as handle:
        handle.write(b"\xff\xd8\xff" + bytes(26 * 1024 * 1024))
    return folder


def open_student_events(page, name):
    page.fill("#searchInput", name)
    page.wait_for_timeout(150)


def wait_status(page, text, timeout=20000):
    page.wait_for_function(
        "t => document.querySelector('#evidenceStatus').textContent.includes(t)", arg=text, timeout=timeout)


def stored_full_image(page, record_id):
    import base64
    import io
    from PIL import Image
    data = page.evaluate("id => { const m = window.__MOCK; const meta = m.db.evidencias[id]; return m.storage[id + '/' + meta.version]; }", record_id)
    return Image.open(io.BytesIO(base64.b64decode(data)))


def test_evidence(browser, db):
    images = make_images()
    edge_today = [key for key, record in db["registros"].items() if record["uid"] == "EDGE01" and record["fecha"] == "2026-10-03"][0]
    edge_no_excuse = [key for key, record in db["registros"].items() if record["uid"] == "EDGE01" and record["fecha"] == "2026-10-01"][0]

    context, page, errors = new_page(browser, db, "uid-directivo", extra=EVIDENCE_MOCK)
    page.on("dialog", lambda dialog: dialog.accept())
    open_student_events(page, "Ñusta")
    buttons = page.locator(".student-card .late-event .small-button")
    buttons.first.click()
    expect(page.locator("#excuseDialog")).to_be_visible()
    check("diálogo de excusa muestra la sección de foto", page.locator(".evidence-editor").is_visible())
    check("escritorio: sin botón de cámara (se usa archivo o arrastrar)", not page.locator("#evidenceCameraButton").is_visible())

    # Archivos no válidos.
    page.set_input_files("#evidenceFileInput", str(images / "excusa.pdf"))
    wait_status(page, "no es una imagen")
    check("PDF rechazado con mensaje claro", True)
    page.set_input_files("#evidenceFileInput", str(images / "IMG_0001.heic"))
    wait_status(page, "HEIC")
    check("HEIC ilegible en este navegador: mensaje con alternativa", "Más compatible" in page.inner_text("#evidenceStatus"))
    page.set_input_files("#evidenceFileInput", str(images / "enorme.jpg"))
    wait_status(page, "25 MB")
    check("imagen de más de 25 MB rechazada", True)

    # Foto pesada de celular: se reduce y se limpia el EXIF.
    started = page.evaluate("performance.now()")
    page.set_input_files("#evidenceFileInput", str(images / "foto-celular.jpg"))
    wait_status(page, "Foto lista")
    prep_ms = page.evaluate(f"performance.now() - {started}")
    status = page.inner_text("#evidenceStatus")
    check("foto de 12 MP preparada", "KB" in status, f"{status} · {prep_ms:.0f} ms")
    check("vista previa visible antes de subir", page.locator("#evidencePreview").is_visible())
    page.click("#saveExcuseButton")
    expect(page.locator("#excuseDialog")).to_be_hidden(timeout=20000)
    stored = stored_full_image(page, edge_today)
    check("foto reducida a máximo 1600 px", max(stored.size) <= 1600, str(stored.size))
    check("orientación EXIF aplicada (vertical)", stored.size[1] > stored.size[0], str(stored.size))
    check("EXIF eliminado (sin GPS ni modelo)", not stored.getexif(), str(dict(stored.getexif())))
    size_kb = page.evaluate("id => window.__MOCK.db.evidencias[id].bytes", edge_today) / 1024
    check("foto comprimida por debajo de 900 KB", size_kb <= 900, f"{size_kb:.0f} KB")
    check("no se reescribió la excusa al sólo añadir foto",
          not any(call.get("op") == "update" for call in page.evaluate("window.__MOCK.calls")))

    thumb = page.locator(f".evidence-thumb[data-record-id='{edge_today}']")
    expect(thumb).to_have_attribute("data-state", "ready", timeout=10000)
    check("miniatura junto a la excusa", thumb.is_visible())
    page.screenshot(path=str(OUT / "evidence-row-desktop.png"))
    thumb.click()
    expect(page.locator("#evidenceViewer")).to_be_visible()
    page.wait_for_function("document.querySelector('#evidenceViewerStatus').textContent === ''", timeout=10000)
    natural = page.evaluate("document.querySelector('#evidenceViewerImage').naturalWidth")
    check("visor muestra la foto completa", natural > 240, str(natural))
    src = page.get_attribute("#evidenceViewerImage", "src")
    check("la imagen se sirve como blob local, sin URL pública", src.startswith("blob:"), src[:30])
    page.screenshot(path=str(OUT / "evidence-viewer-desktop.png"))
    page.click("#evidenceViewer [data-close-dialog]")

    # Reemplazo con arrastrar y soltar + fallo de red con reintento.
    first_version = page.evaluate("id => window.__MOCK.db.evidencias[id].version", edge_today)
    buttons.first.click()
    page.wait_for_function("!document.querySelector('#evidencePreview').hidden", timeout=10000)
    check("al reabrir se ve la foto actual y la opción de reemplazar",
          page.inner_text("#evidenceFileButton") == "Reemplazar foto" and page.locator("#evidenceRemoveButton").is_visible())
    png_bytes = (images / "captura.png").read_bytes()
    handle = page.evaluate_handle("""bytes => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], 'captura.png', { type: 'image/png' }));
      return transfer;
    }""", list(png_bytes))
    page.dispatch_event("#evidenceDropZone", "drop", {"dataTransfer": handle})
    wait_status(page, "Foto lista")
    check("arrastrar y soltar acepta la imagen", True)
    page.evaluate("window.__MOCK.failNextUpload = true; window.__MOCK.functionLatencyMs = 1200")
    page.click("#saveExcuseButton")
    wait_status(page, "Subiendo foto")
    check("estado de carga visible durante la subida", page.locator("#evidenceFileButton").is_disabled())
    wait_status(page, "no se pudo subir")
    check("error de subida visible y diálogo abierto", page.locator("#excuseDialog").is_visible() and page.locator("#evidenceRetryButton").is_visible())
    page.evaluate("window.__MOCK.functionLatencyMs = 50")
    page.click("#evidenceRetryButton")
    expect(page.locator("#excuseDialog")).to_be_hidden(timeout=10000)
    second_version = page.evaluate("id => window.__MOCK.db.evidencias[id].version", edge_today)
    stored = stored_full_image(page, edge_today)
    check("reintento reemplaza la foto (nueva versión)", second_version != first_version)
    check("PNG transparente queda con fondo blanco", stored.convert("RGB").getpixel((5, 5))[0] > 240, str(stored.convert("RGB").getpixel((5, 5))))
    check("la versión anterior se borró del almacenamiento",
          page.evaluate("id => Object.keys(window.__MOCK.storage).filter(k => k.startsWith(id + '/')).length", edge_today) == 2)

    # Quitar foto.
    buttons.first.click()
    page.wait_for_function("!document.querySelector('#evidencePreview').hidden", timeout=10000)
    page.click("#evidenceRemoveButton")
    wait_status(page, "Foto quitada")
    check("quitar foto borra metadatos", page.evaluate("id => !(window.__MOCK.db.evidencias || {})[id]", edge_today))
    page.click("#excuseDialog [data-close-dialog]")
    check("sin foto ya no hay miniatura", page.locator(f".evidence-thumb[data-record-id='{edge_today}']").count() == 0)

    # Excusa nueva con foto en el mismo paso.
    page.locator(f".late-event:has-text('1 de oct') .small-button").first.click()
    page.fill("#excuseReasonInput", "Cita médica — soporte adjunto")
    page.set_input_files("#evidenceFileInput", str(images / "captura.png"))
    wait_status(page, "Foto lista")
    page.click("#saveExcuseButton")
    expect(page.locator("#excuseDialog")).to_be_hidden(timeout=10000)
    check("excusa nueva + foto en un solo guardado",
          page.evaluate("id => Boolean(window.__MOCK.db.registros[id].justificacion && window.__MOCK.db.evidencias[id])", edge_no_excuse))

    # Quitar la excusa también quita su foto (primero la foto).
    page.locator(f".late-event:has-text('1 de oct') .small-button").first.click()
    page.click("#deleteExcuseButton")
    expect(page.locator("#excuseDialog")).to_be_hidden(timeout=10000)
    check("quitar excusa elimina antes su foto",
          page.evaluate("id => !window.__MOCK.db.registros[id].justificacion && !(window.__MOCK.db.evidencias || {})[id]", edge_no_excuse))

    # Dejar una foto para las pruebas de docente.
    buttons.first.click()
    page.set_input_files("#evidenceFileInput", str(images / "captura.png"))
    wait_status(page, "Foto lista")
    page.click("#saveExcuseButton")
    expect(page.locator("#excuseDialog")).to_be_hidden(timeout=10000)
    shared_db = page.evaluate("window.__MOCK.db")
    shared_storage = page.evaluate("window.__MOCK.storage")
    # El único error esperado es el fallo de red inyectado a propósito en la subida.
    real_errors = [error for error in errors if "Error: unavailable" not in error]
    check("directivo: sin errores inesperados de consola", not real_errors, "; ".join(real_errors[:3]))
    context.close()

    # Docente: ve la miniatura y la foto, pero no puede editar.
    restore = "window.__MOCK.storage = " + json.dumps(shared_storage) + ";"
    context, page, errors = new_page(browser, shared_db, "uid-docente", extra=EVIDENCE_MOCK + restore)
    open_student_events(page, "Ñusta")
    thumb = page.locator(f".evidence-thumb[data-record-id='{edge_today}']")
    expect(thumb).to_have_attribute("data-state", "ready", timeout=10000)
    check("docente ve la miniatura", thumb.is_visible())
    check("docente no tiene botones de excusa", page.locator(".late-event .small-button").count() == 0)
    thumb.click()
    page.wait_for_function("document.querySelector('#evidenceViewerStatus').textContent === ''", timeout=10000)
    check("docente amplía la foto", page.locator("#evidenceViewerImage").is_visible())
    page.click("#evidenceViewer [data-close-dialog]")
    open_stats(page)
    pick_period(page, "hoy")
    check("estadísticas marcan 'Con foto'", "Con foto" in page.inner_text("#statsList"))
    page.click("#statsDialog [data-close-dialog]")

    # Función caída: la miniatura muestra error y permite reintentar.
    page.evaluate("window.__MOCK.functionDown = true")
    page.click("#logoutButton")
    page.wait_for_selector("#loginView:not([hidden])")
    page.fill("#emailInput", "x@y.co")
    page.fill("#passwordInput", "12345678")
    page.click("#loginButton")
    page.wait_for_selector("#appView:not([hidden])")
    open_student_events(page, "Ñusta")
    thumb = page.locator(f".evidence-thumb[data-record-id='{edge_today}']")
    expect(thumb).to_have_attribute("data-state", "error", timeout=10000)
    check("al cerrar sesión se vacía la caché y un fallo muestra 'Reintentar'", True)
    page.evaluate("window.__MOCK.functionDown = false")
    thumb.click()
    expect(thumb).to_have_attribute("data-state", "ready", timeout=10000)
    check("reintento de miniatura funciona", True)
    context.close()

    # Usuario inactivo: no entra al panel.
    context = browser.new_context(timezone_id="Asia/Tokyo", locale="es-CO")
    context.route("https://www.gstatic.com/firebasejs/**", lambda route: route.fulfill(status=200, content_type="text/javascript", body=MOCK_JS))
    page = context.new_page()
    page.add_init_script(init_script(shared_db, "uid-inactivo", EVIDENCE_MOCK))
    page.goto(f"http://127.0.0.1:{PORT}/index.html")
    page.wait_for_function("!document.querySelector('#loginError').hidden", timeout=10000)
    check("cuenta inactiva no accede (ni a fotos ni a estadísticas)", page.locator("#appView").is_hidden()
          and "perfil activo" in page.inner_text("#loginError"))
    context.close()

    # Móvil: botón de cámara y diseño.
    context, page, errors = new_page(browser, shared_db, "uid-directivo", viewport={"width": 390, "height": 844}, extra=EVIDENCE_MOCK + restore)
    open_student_events(page, "Ñusta")
    thumb = page.locator(f".evidence-thumb[data-record-id='{edge_today}']")
    thumb.scroll_into_view_if_needed()
    expect(thumb).to_have_attribute("data-state", "ready", timeout=10000)
    page.screenshot(path=str(OUT / "evidence-row-mobile.png"))
    page.locator(".late-event .small-button").first.click()
    check("móvil: botón 'Tomar foto' visible", page.locator("#evidenceCameraButton").is_visible())
    check("móvil: la cámara usa capture=environment", page.get_attribute("#evidenceCameraInput", "capture") == "environment")
    page.wait_for_function("!document.querySelector('#evidencePreview').hidden", timeout=10000)
    page.locator(".evidence-editor").scroll_into_view_if_needed()
    page.screenshot(path=str(OUT / "evidence-editor-mobile.png"))
    check("móvil: sin desbordamiento horizontal",
          page.evaluate("document.querySelector('#excuseDialog').scrollWidth <= document.querySelector('#excuseDialog').clientWidth + 1"))
    context.close()


def main():
    selected = set(sys.argv[1:]) or {"stats", "export", "evidence"}
    db = fixture.build()
    server = serve()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        if "stats" in selected:
            test_stats(browser, db)
        if "export" in selected and "test_export" in globals():
            globals()["test_export"](browser, db)
        if "evidence" in selected and "test_evidence" in globals():
            globals()["test_evidence"](browser, db)
        browser.close()
    server.shutdown()
    failed = [result for result in RESULTS if not result[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} comprobaciones superadas")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
