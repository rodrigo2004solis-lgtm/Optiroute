"""Pruebas del motor de OptiRoute.  Ejecutar:  python -m pytest -q"""
import json
from pathlib import Path

from engine.modelo import balancear, comparar_metodos, costos_por_distancia, esquina_noreste, resolver, vogel

BASE = Path(__file__).resolve().parents[1]


def escenario():
    e = json.loads((BASE / "data" / "escenario_base.json").read_text(encoding="utf-8"))
    c = costos_por_distancia(e["almacenes"], e["sucursales"])
    return c, [a["oferta"] for a in e["almacenes"]], [s["demanda"] for s in e["sucursales"]]


def test_problema_balanceado_clasico():
    # Ejemplo pequeño: oferta = demanda = 50
    c = [[2, 3, 1], [5, 4, 8]]
    r = resolver(c, [20, 30], [10, 25, 15], calcular_rangos=False)
    assert r.estado == "optimo"
    assert r.ficticio_tipo is None
    for i, s in enumerate([20, 30]):
        assert abs(sum(r.x[i]) - s) < 1e-6


def test_escenario_base_respeta_restricciones():
    c, s, d = escenario()
    r = resolver(c, s, d, calcular_rangos=False)
    assert r.estado == "optimo"
    for j in range(len(d)):
        assert abs(sum(r.x[i][j] for i in range(len(s))) - d[j]) < 1e-6
    for i in range(len(s)):
        assert sum(r.x[i]) <= s[i] + 1e-6
    assert r.ficticio_tipo == "destino" and abs(sum(r.ficticio) - (sum(s) - sum(d))) < 1e-6


def test_optimo_no_es_peor_que_metodos_iniciales():
    c, s, d = escenario()
    r = resolver(c, s, d, calcular_rangos=False)
    for nombre, v in comparar_metodos(c, s, d, r.costo_total).items():
        assert v["costo"] >= r.costo_total - 1e-6, nombre


def test_metodos_iniciales_son_factibles():
    c, s, d = escenario()
    cb, sb, db = balancear(c, s, d)
    for metodo in (esquina_noreste, vogel):
        x = metodo(cb, sb, db)
        assert all(abs(sum(x[i]) - sb[i]) < 1e-6 for i in range(len(sb)))
        assert all(abs(sum(x[i][j] for i in range(len(sb))) - db[j]) < 1e-6 for j in range(len(db)))


def test_precio_sombra_predice_cambio_de_costo():
    # Aumentar en 1 la demanda de una sucursal debe subir el costo en su precio sombra
    c, s, d = escenario()
    r0 = resolver(c, s, d, calcular_rangos=False)
    d2 = d[:]
    d2[0] += 1
    r1 = resolver(c, s, d2, calcular_rangos=False)
    assert abs((r1.costo_total - r0.costo_total) - r0.precio_sombra_demanda[0]) < 1e-6


def test_demanda_mayor_que_oferta_usa_origen_ficticio():
    r = resolver([[4, 6], [5, 3]], [10, 10], [15, 15], calcular_rangos=False)
    assert r.ficticio_tipo == "origen"
    assert abs(sum(r.ficticio) - 10) < 1e-6
