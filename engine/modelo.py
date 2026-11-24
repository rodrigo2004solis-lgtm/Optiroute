"""
Motor cuantitativo de OptiRoute.

Modelo de transporte a costo mínimo:

    Min Z = sum_i sum_j c_ij * x_ij
    s.a.  sum_j x_ij <= s_i   (o = s_i)   para cada almacén i   (oferta)
          sum_i x_ij  = d_j   (o <= d_j)  para cada sucursal j  (demanda)
          x_ij >= 0

Cuando la oferta total es distinta de la demanda total, el problema se
balancea agregando un destino ficticio (exceso de oferta) o un origen
ficticio (demanda no cubierta) con costo cero. En el modelo lineal esto
equivale a dejar como desigualdad (<=) las restricciones del lado que
sobra; la holgura de esas restricciones es lo que se envía al ficticio.

Se resuelve con SciPy (linprog, método HiGHS), que además entrega los
precios sombra (variables duales) y los costos reducidos.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import linprog

TOL = 1e-7


# ----------------------------------------------------------------------
# Utilidades
# ----------------------------------------------------------------------
def distancia_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Distancia en línea recta (fórmula de Haversine) entre dos puntos."""
    r = 6371.0
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def costos_por_distancia(almacenes, sucursales, costo_fijo=40.0, costo_km=1.8, factor_carretera=1.25):
    """Matriz de costos por lote: costo fijo de carga + costo por km de carretera."""
    c = []
    for a in almacenes:
        fila = []
        for s in sucursales:
            km = distancia_km((a["lat"], a["lng"]), (s["lat"], s["lng"])) * factor_carretera
            fila.append(round(costo_fijo + costo_km * km))
        c.append(fila)
    return c


# ----------------------------------------------------------------------
# Resultado
# ----------------------------------------------------------------------
@dataclass
class Resultado:
    estado: str
    costo_total: float
    x: list[list[float]]                 # envíos reales almacén -> sucursal
    ficticio_tipo: str | None            # "destino", "origen" o None
    ficticio: list[float]                # envíos al/desde el ficticio
    oferta_total: float
    demanda_total: float
    precio_sombra_oferta: list[float]    # dZ/ds_i
    precio_sombra_demanda: list[float]   # dZ/dd_j
    costo_reducido: list[list[float]]
    rangos: list[list[dict]] = field(default_factory=list)
    metodos_iniciales: dict = field(default_factory=dict)


# ----------------------------------------------------------------------
# Modelo lineal
# ----------------------------------------------------------------------
def _resolver_lp(c, oferta, demanda):
    m, n = len(oferta), len(demanda)
    c = np.asarray(c, float)
    s = np.asarray(oferta, float)
    d = np.asarray(demanda, float)
    exceso_oferta = s.sum() >= d.sum() - TOL

    # Restricciones de oferta (filas) y demanda (columnas)
    A_of = np.zeros((m, m * n))
    for i in range(m):
        A_of[i, i * n:(i + 1) * n] = 1
    A_de = np.zeros((n, m * n))
    for j in range(n):
        A_de[j, j::n] = 1

    if exceso_oferta:      # oferta <= s_i , demanda = d_j
        A_ub, b_ub, A_eq, b_eq = A_of, s, A_de, d
    else:                  # oferta = s_i , demanda <= d_j
        A_ub, b_ub, A_eq, b_eq = A_de, d, A_of, s

    res = linprog(c.ravel(), A_ub=A_ub, b_ub=b_ub, A_eq=A_eq, b_eq=b_eq,
                  bounds=[(0, None)] * (m * n), method="highs")
    return res, exceso_oferta


def resolver(c, oferta, demanda, calcular_rangos=True) -> Resultado:
    m, n = len(oferta), len(demanda)
    res, exceso_oferta = _resolver_lp(c, oferta, demanda)
    if res.status != 0:
        return Resultado("sin_solucion: " + res.message, 0, [], None, [], sum(oferta), sum(demanda),
                         [], [], [])

    x = res.x.reshape(m, n)
    if exceso_oferta:
        ps_of = list(res.ineqlin.marginals)
        ps_de = list(res.eqlin.marginals)
        ficticio = [oferta[i] - x[i].sum() for i in range(m)]
        tipo = "destino" if sum(ficticio) > TOL else None
    else:
        ps_de = list(res.ineqlin.marginals)
        ps_of = list(res.eqlin.marginals)
        ficticio = [demanda[j] - x[:, j].sum() for j in range(n)]
        tipo = "origen"

    cr = res.lower.marginals.reshape(m, n)
    r = Resultado(
        estado="optimo",
        costo_total=float(res.fun),
        x=_limpia(x),
        ficticio_tipo=tipo,
        ficticio=_limpia(ficticio),
        oferta_total=float(sum(oferta)),
        demanda_total=float(sum(demanda)),
        precio_sombra_oferta=_limpia(ps_of),
        precio_sombra_demanda=_limpia(ps_de),
        costo_reducido=_limpia(cr),
    )
    if calcular_rangos:
        r.rangos = rangos_costos(c, oferta, demanda, x)
    r.metodos_iniciales = comparar_metodos(c, oferta, demanda, r.costo_total)
    return r


def _limpia(v):
    a = np.asarray(v, float)
    a[np.abs(a) < 1e-6] = 0.0
    a = np.round(a, 4)
    return a.tolist()


# ----------------------------------------------------------------------
# Análisis de sensibilidad: rango de cada costo c_ij
# ----------------------------------------------------------------------
def rangos_costos(c, oferta, demanda, x_opt, limite=100000.0):
    """Para cada ruta, cuánto puede bajar o subir su costo sin que cambie el
    plan óptimo de envíos. Para rutas no usadas el límite inferior es exacto
    (costo - costo reducido); en general se obtiene re-optimizando con
    búsqueda binaria."""
    c = np.asarray(c, float)
    m, n = c.shape
    x_opt = np.asarray(x_opt)

    def mismo_plan(i, j, nuevo):
        c2 = c.copy()
        c2[i, j] = nuevo
        res, _ = _resolver_lp(c2, oferta, demanda)
        if res.status != 0:
            return False
        # El plan es el mismo si el costo del plan anterior sigue siendo óptimo
        costo_anterior = float((c2 * x_opt).sum())
        return abs(costo_anterior - res.fun) <= 1e-6 * max(1.0, abs(res.fun))

    def buscar(i, j, direccion):
        base = c[i, j]
        paso = 1.0
        ok = 0.0
        while paso <= limite:
            if mismo_plan(i, j, base + direccion * paso):
                ok = paso
                paso *= 2
            else:
                break
        if paso > limite:
            return math.inf
        lo, hi = ok, paso
        while hi - lo > 0.5:
            mid = (lo + hi) / 2
            if mismo_plan(i, j, base + direccion * mid):
                lo = mid
            else:
                hi = mid
        return round(lo, 1)

    out = []
    for i in range(m):
        fila = []
        for j in range(n):
            baja = buscar(i, j, -1)
            sube = buscar(i, j, +1)
            fila.append({
                "costo": float(c[i, j]),
                "min": None if math.isinf(baja) else float(round(c[i, j] - baja, 1)),
                "max": None if math.isinf(sube) else float(round(c[i, j] + sube, 1)),
            })
        out.append(fila)
    return out


# ----------------------------------------------------------------------
# Métodos de solución inicial vistos en clase (para comparar)
# ----------------------------------------------------------------------
def balancear(c, oferta, demanda):
    """Devuelve la tabla balanceada (agrega fila o columna ficticia de costo 0)."""
    c = [list(map(float, f)) for f in c]
    s, d = list(map(float, oferta)), list(map(float, demanda))
    ts, td = sum(s), sum(d)
    if ts > td + TOL:
        for f in c:
            f.append(0.0)
        d.append(ts - td)
    elif td > ts + TOL:
        c.append([0.0] * len(d))
        s.append(td - ts)
    return c, s, d


def esquina_noreste(c, s, d):
    s, d = s[:], d[:]
    m, n = len(s), len(d)
    x = [[0.0] * n for _ in range(m)]
    i = j = 0
    while i < m and j < n:
        q = min(s[i], d[j])
        x[i][j] = q
        s[i] -= q
        d[j] -= q
        if s[i] <= TOL:
            i += 1
        else:
            j += 1
    return x


def costo_minimo(c, s, d):
    s, d = s[:], d[:]
    m, n = len(s), len(d)
    x = [[0.0] * n for _ in range(m)]
    celdas = sorted(((c[i][j], i, j) for i in range(m) for j in range(n)))
    for _, i, j in celdas:
        if s[i] > TOL and d[j] > TOL:
            q = min(s[i], d[j])
            x[i][j] = q
            s[i] -= q
            d[j] -= q
    return x


def vogel(c, s, d):
    s, d = s[:], d[:]
    m, n = len(s), len(d)
    x = [[0.0] * n for _ in range(m)]
    filas, cols = set(range(m)), set(range(n))

    def pen(valores):
        v = sorted(valores)
        return v[1] - v[0] if len(v) > 1 else v[0]

    while filas and cols:
        mejores = []
        for i in filas:
            mejores.append((pen([c[i][j] for j in cols]), 0, i))
        for j in cols:
            mejores.append((pen([c[i][j] for i in filas]), 1, j))
        p, tipo, k = max(mejores, key=lambda t: (t[0], -t[1]))
        if tipo == 0:
            i = k
            j = min(cols, key=lambda jj: c[i][jj])
        else:
            j = k
            i = min(filas, key=lambda ii: c[ii][j])
        q = min(s[i], d[j])
        x[i][j] = q
        s[i] -= q
        d[j] -= q
        if s[i] <= TOL:
            filas.discard(i)
        if d[j] <= TOL:
            cols.discard(j)
    return x


def costo_de(c, x):
    return float(sum(c[i][j] * x[i][j] for i in range(len(x)) for j in range(len(x[0]))))


def comparar_metodos(c, oferta, demanda, optimo):
    cb, s, d = balancear(c, oferta, demanda)
    salida = {}
    for nombre, f in (("Esquina noreste", esquina_noreste), ("Costo mínimo", costo_minimo), ("Vogel", vogel)):
        costo = costo_de(cb, f(cb, s, d))
        salida[nombre] = {"costo": round(costo, 2),
                          "diferencia": round(costo - optimo, 2),
                          "pct": round(100 * (costo - optimo) / optimo, 2) if optimo else 0}
    salida["Óptimo (HiGHS)"] = {"costo": round(optimo, 2), "diferencia": 0.0, "pct": 0.0}
    return salida
