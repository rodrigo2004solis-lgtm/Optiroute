"""
OptiRoute - Sistema web de optimización de rutas y logística.
Proyecto Integrador de Investigación de Operaciones.

Ejecutar:
    pip install -r requirements.txt
    python app.py
y abrir http://127.0.0.1:5000
"""
import json
from dataclasses import asdict
from pathlib import Path

from flask import Flask, jsonify, render_template, request

from engine.modelo import balancear, costos_por_distancia, resolver

BASE = Path(__file__).parent
app = Flask(__name__)
app.json.sort_keys = False


def _numero(v, nombre, minimo=0.0):
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise ValueError(f"El valor de '{nombre}' no es un número.")
    if x < minimo:
        raise ValueError(f"El valor de '{nombre}' no puede ser negativo.")
    return x


def _leer_nodos(lista, campo):
    if not isinstance(lista, list) or not lista:
        raise ValueError("Debe haber al menos un almacén y una sucursal.")
    nodos = []
    for k, n in enumerate(lista, 1):
        nombre = str(n.get("nombre") or f"Nodo {k}").strip()[:60]
        nodos.append({
            "nombre": nombre,
            "lat": _numero(n.get("lat"), f"latitud de {nombre}", -90),
            "lng": _numero(n.get("lng"), f"longitud de {nombre}", -180),
            campo: _numero(n.get(campo), f"{campo} de {nombre}"),
        })
    return nodos


@app.get("/")
def inicio():
    return render_template("index.html")


@app.get("/api/escenario")
def escenario():
    return jsonify(json.loads((BASE / "data" / "escenario_base.json").read_text(encoding="utf-8")))


@app.post("/api/costos")
def costos():
    try:
        datos = request.get_json(force=True)
        alm = _leer_nodos(datos.get("almacenes"), "oferta")
        suc = _leer_nodos(datos.get("sucursales"), "demanda")
        c = costos_por_distancia(alm, suc,
                                 costo_fijo=_numero(datos.get("costo_fijo", 40), "costo fijo"),
                                 costo_km=_numero(datos.get("costo_km", 1.8), "costo por km"),
                                 factor_carretera=_numero(datos.get("factor_carretera", 1.25), "factor carretera", 1))
        return jsonify({"costos": c})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.post("/api/resolver")
def api_resolver():
    try:
        datos = request.get_json(force=True)
        alm = _leer_nodos(datos.get("almacenes"), "oferta")
        suc = _leer_nodos(datos.get("sucursales"), "demanda")
        c = datos.get("costos")
        if not isinstance(c, list) or len(c) != len(alm) or any(len(f) != len(suc) for f in c):
            raise ValueError("La matriz de costos no coincide con el número de almacenes y sucursales.")
        c = [[_numero(v, f"costo {alm[i]['nombre']} → {suc[j]['nombre']}") for j, v in enumerate(f)]
             for i, f in enumerate(c)]
        oferta = [a["oferta"] for a in alm]
        demanda = [s["demanda"] for s in suc]
        if sum(oferta) == 0 or sum(demanda) == 0:
            raise ValueError("La oferta y la demanda totales deben ser mayores que cero.")
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    r = resolver(c, oferta, demanda, calcular_rangos=bool(datos.get("rangos", True)))
    if r.estado != "optimo":
        return jsonify({"error": "El modelo no tiene solución: " + r.estado}), 422
    cb, sb, db = balancear(c, oferta, demanda)
    salida = asdict(r)
    salida["tabla_balanceada"] = {"costos": cb, "oferta": sb, "demanda": db}
    salida["almacenes"] = alm
    salida["sucursales"] = suc
    salida["costos"] = c
    return jsonify(salida)


if __name__ == "__main__":
    app.run(debug=True)
