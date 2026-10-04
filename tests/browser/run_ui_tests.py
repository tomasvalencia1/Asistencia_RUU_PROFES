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
