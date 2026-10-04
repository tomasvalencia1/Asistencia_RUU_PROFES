"""Datos de prueba deterministas para el arnés de interfaz.

Incluye casos borde: nombres con tildes y ñ, grupo heredado numérico (102),
estudiante retirado, registros sin franja conocida, cambio de mes y de año,
registros "a tiempo" (tarde: false) que no deben contarse y un volumen alto
para medir rendimiento.
"""
import random
from datetime import date, timedelta

GROUPS = [f"{g}.{s}" for g in range(6, 12) for s in range(1, 4)]
FIRST = ["José", "María", "Ángela", "Sebastián", "Valentina", "Andrés", "Lucía", "Martín", "Sofía", "Nicolás", "Camila", "Tomás"]
LAST = ["Peña", "Muñoz", "Gómez", "Álvarez", "Zuñiga", "Ríos", "Ospina", "Castaño", "Úsuga", "Ibáñez"]
FRANJAS = [("entrada", 7, 0), ("descanso1", 9, 10), ("descanso2", 12, 10)]
STAFF = {
    "uid-docente": {"nombre": "Docente Prueba", "rol": "docente", "activo": True},
    "uid-directivo": {"nombre": "Directiva Prueba", "rol": "directivo", "activo": True},
    "uid-admin": {"nombre": "Admin Prueba", "rol": "admin", "activo": True},
    "uid-inactivo": {"nombre": "Inactivo Prueba", "rol": "directivo", "activo": False},
}


def build(students_count=600, late_per_day=40, seed=7):
    rng = random.Random(seed)
    students = {}
    for index in range(students_count):
        uid = f"{0xA0000 + index:X}"
        name = f"{rng.choice(FIRST)} {rng.choice(LAST)} {rng.choice(LAST)} {index}"
        students[uid] = {"nombre": name, "grupo": GROUPS[index % len(GROUPS)], "llegadasTarde": 0}

    # Casos borde explícitos.
    students["EDGE01"] = {"nombre": "Ñusta Ibáñez Úsuga", "grupo": "6.1", "llegadasTarde": 0}
    students["EDGE02"] = {"nombre": "Legado Grupo Numérico", "grupo": 102, "llegadasTarde": 0}

    records = {}
    counter = 0

    def add(uid, student, day, hour, minute, second, periodo, tarde=True, justificacion=None, grupo=None):
        nonlocal counter
        counter += 1
        record = {
            "uid": uid,
            "nombre": student["nombre"],
            "grupo": grupo if grupo is not None else student["grupo"],
            "fecha": day.isoformat(),
            "hora": f"{hour:02d}:{minute:02d}:{second:02d}",
            # timestamp coherente con la hora de Bogotá (UTC-5).
            "timestamp": int(((day - date(1970, 1, 1)).days * 86400 + (hour + 5) * 3600 + minute * 60 + second) * 1000),
            "periodo": periodo,
            "tarde": tarde,
        }
        if justificacion:
            record["justificacion"] = justificacion
        records[f"-Nrec{counter:06d}"] = record

    uids = list(students)
    start = date(2026, 8, 3)
    day = start
    while day <= date(2026, 10, 3):
        if day.weekday() < 5:
            for _ in range(late_per_day):
                uid = rng.choice(uids)
                periodo, hour, minute = rng.choice(FRANJAS)
                state = rng.random()
                just = None
                if state < 0.15:
                    just = {"estado": "validada", "motivo": "Cita médica con soporte", "revisadaPorUid": "uid-directivo", "revisadaEn": 1}
                elif state < 0.22:
                    just = {"estado": "rechazada", "motivo": "Sin soporte", "revisadaPorUid": "uid-directivo", "revisadaEn": 1}
                elif state < 0.3:
                    just = {"estado": "pendiente", "motivo": "Acudiente enviará la excusa", "revisadaPorUid": "uid-directivo", "revisadaEn": 1}
                add(uid, students[uid], day, hour, minute + rng.randint(1, 40), rng.randint(0, 59), periodo, justificacion=just)
            # Registros a tiempo que no deben contarse.
            uid = rng.choice(uids)
            add(uid, students[uid], day, 6, 50, 0, "entrada", tarde=False)
        day += timedelta(days=1)

    # Cambio de año y estudiante retirado (sus registros existen pero ya no está en estudiantes).
    retirado = {"nombre": "Retirado Castaño", "grupo": "11.3"}
    add("DEAD01", retirado, date(2026, 12, 31), 7, 3, 0, "entrada")
    add("DEAD01", retirado, date(2027, 1, 1), 7, 4, 0, "entrada")
    add("EDGE01", students["EDGE01"], date(2026, 10, 3), 7, 10, 0, "entrada",
        justificacion={"estado": "validada", "motivo": "Cita odontológica — acudiente", "revisadaPorUid": "uid-admin", "revisadaEn": 1})
    add("EDGE02", students["EDGE02"], date(2026, 10, 2), 9, 20, 0, "descanso1", grupo=102)
    add("EDGE01", students["EDGE01"], date(2026, 10, 1), 13, 0, 0, "otra-franja")

    return {
        "usuarios": STAFF,
        "estudiantes": students,
        "registros": records,
        "config": {"franjas": {"entrada": {"horaLimite": "07:00:00"}}},
    }


def expected_count(db, start, end, group=None, excuse=None):
    """Conteo independiente (en Python) para contrastar con query.js."""
    total = 0
    for record in db["registros"].values():
        if record.get("tarde") not in (True, "true") or not record.get("uid"):
            continue
        if not (start <= record["fecha"] <= end):
            continue
        record_group = record.get("grupo")
        if record_group == 102:
            record_group = "10.2"
        if group and record_group != group:
            continue
        just = record.get("justificacion")
        state = "sin" if not just else (just["estado"] if just["estado"] in ("validada", "rechazada") else "pendiente")
        if excuse and state != excuse:
            continue
        total += 1
    return total
