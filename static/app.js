// OptiRoute - interfaz web
const estado = { almacenes: [], sucursales: [], costos: [], resultado: null };
const $ = (id) => document.getElementById(id);
const fmt = (v, d = 0) => Number(v).toLocaleString("es-MX", { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (v) => (v < 0 ? "-$" : "$") + fmt(Math.abs(v), 0);

function el(tag, attrs = {}, ...hijos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const h of hijos) e.append(h instanceof Node ? h : document.createTextNode(h ?? ""));
  return e;
}

// ---------------------------------------------------------------- entrada
function tablaNodos(id, lista, campo, etiqueta) {
  const t = $(id);
  t.replaceChildren(el("tr", {}, el("th", {}, "Nombre"), el("th", {}, "Lat"), el("th", {}, "Lng"), el("th", {}, etiqueta), el("th")));
  lista.forEach((n, k) => {
    const inp = (prop, cls = "", step = "any") => {
      const i = el("input", { class: cls, value: n[prop], type: prop === "nombre" ? "text" : "number", step });
      i.addEventListener("change", () => {
        n[prop] = prop === "nombre" ? i.value : parseFloat(i.value);
        if (prop === "nombre") dibujarCostos();
      });
      return el("td", {}, i);
    };
    t.append(el("tr", {}, inp("nombre", "name"), inp("lat"), inp("lng"), inp(campo, "", "1"),
      el("td", {}, el("button", { class: "del", title: "Eliminar", onclick: () => quitar(lista, k) }, "✕"))));
  });
}

function quitar(lista, k) {
  if (lista.length <= 1) return aviso("Debe quedar al menos un elemento.");
  const esAlm = lista === estado.almacenes;
  lista.splice(k, 1);
  if (esAlm) estado.costos.splice(k, 1);
  else estado.costos.forEach((f) => f.splice(k, 1));
  dibujarEntradas();
}

function dibujarCostos() {
  const t = $("tbl-costos");
  const head = el("tr", {}, el("th", {}, "Almacén \\ Sucursal"));
  estado.sucursales.forEach((s) => head.append(el("th", { class: "num" }, s.nombre)));
  t.replaceChildren(head);
  estado.almacenes.forEach((a, i) => {
    const tr = el("tr", {}, el("th", {}, a.nombre));
    estado.sucursales.forEach((_, j) => {
      const i2 = el("input", { type: "number", step: "1", value: estado.costos[i]?.[j] ?? 0 });
      i2.addEventListener("change", () => (estado.costos[i][j] = parseFloat(i2.value)));
      tr.append(el("td", {}, i2));
    });
    t.append(tr);
  });
}

function dibujarEntradas() {
  tablaNodos("tbl-alm", estado.almacenes, "oferta", "Oferta");
  tablaNodos("tbl-suc", estado.sucursales, "demanda", "Demanda");
  dibujarCostos();
}

// ---------------------------------------------------------------- API
async function api(ruta, cuerpo) {
  const r = await fetch(ruta, { method: cuerpo ? "POST" : "GET", headers: { "Content-Type": "application/json" }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "Error del servidor");
  return j;
}

function aviso(texto, tipo = "") {
  const m = $("msg");
  m.className = "msg " + tipo;
  m.textContent = texto;
  if (!texto) m.classList.add("hidden");
}

async function cargarBase() {
  const e = await api("/api/escenario");
  estado.almacenes = e.almacenes;
  estado.sucursales = e.sucursales;
  $("p-fijo").value = e.costo_fijo;
  $("p-km").value = e.costo_km;
  $("p-fac").value = e.factor_carretera;
  await calcularCostos();
  await optimizar();
}

async function calcularCostos() {
  const r = await api("/api/costos", {
    almacenes: estado.almacenes, sucursales: estado.sucursales,
    costo_fijo: $("p-fijo").value, costo_km: $("p-km").value, factor_carretera: $("p-fac").value,
  });
  estado.costos = r.costos;
  dibujarEntradas();
}

async function optimizar() {
  document.body.classList.add("busy");
  try {
    aviso("");
    const r = await api("/api/resolver", { almacenes: estado.almacenes, sucursales: estado.sucursales, costos: estado.costos });
    estado.resultado = r;
    mostrar(r);
  } catch (e) {
    aviso(e.message);
  } finally {
    document.body.classList.remove("busy");
  }
}

// ---------------------------------------------------------------- resultados
function mostrar(r) {
  const A = r.almacenes, S = r.sucursales;
  const rutas = r.x.flat().filter((v) => v > 0).length;
  const vogel = r.metodos_iniciales["Vogel"];
  $("k-costo").textContent = money(r.costo_total);
  $("k-balance").textContent = `${fmt(r.oferta_total)} / ${fmt(r.demanda_total)}`;
  const tf = r.ficticio.reduce((a, b) => a + b, 0);
  $("k-fict").textContent = r.ficticio_tipo === "destino" ? `Destino ficticio: ${fmt(tf)} lotes sin enviar`
    : r.ficticio_tipo === "origen" ? `Origen ficticio: ${fmt(tf)} lotes sin surtir` : "Problema balanceado";
  $("k-ahorro").textContent = money(vogel.diferencia);
  $("k-ahorro2").textContent = `${fmt(vogel.pct, 2)} % menos que la solución inicial de Vogel`;
  $("k-rutas").textContent = rutas;

  // Plan óptimo (tabla balanceada)
  const t = $("tbl-plan");
  const fic = r.ficticio_tipo;
  const head = el("tr", {}, el("th", {}, "Almacén \\ Sucursal"));
  S.forEach((s) => head.append(el("th", { class: "num" }, s.nombre)));
  if (fic === "destino") head.append(el("th", { class: "num" }, "Ficticio"));
  head.append(el("th", { class: "num" }, "Enviado"), el("th", { class: "num" }, "Oferta"));
  t.replaceChildren(head);
  A.forEach((a, i) => {
    const tr = el("tr", {}, el("th", {}, a.nombre));
    r.x[i].forEach((v, j) => tr.append(el("td", { class: "num" + (v > 0 ? " pos" : "") }, v > 0 ? `${fmt(v)} × ${money(r.costos[i][j])}` : "–")));
    if (fic === "destino") tr.append(el("td", { class: "num" + (r.ficticio[i] > 0 ? " fict" : "") }, r.ficticio[i] > 0 ? fmt(r.ficticio[i]) : "–"));
    tr.append(el("td", { class: "num" }, fmt(r.x[i].reduce((p, q) => p + q, 0))), el("td", { class: "num" }, fmt(a.oferta)));
    t.append(tr);
  });
  if (fic === "origen") {
    const tr = el("tr", {}, el("th", {}, "Ficticio (sin surtir)"));
    r.ficticio.forEach((v) => tr.append(el("td", { class: "num" + (v > 0 ? " fict" : "") }, v > 0 ? fmt(v) : "–")));
    t.append(tr);
  }
  const tot = el("tr", { class: "total" }, el("td", {}, "Demanda"));
  S.forEach((s) => tot.append(el("td", { class: "num" }, fmt(s.demanda))));
  if (fic === "destino") tot.append(el("td", { class: "num" }, fmt(tf)));
  tot.append(el("td", { class: "num" }, money(r.costo_total)), el("td"));
  t.append(tot);

  // Precios sombra
  const pso = $("tbl-ps-of");
  pso.replaceChildren(el("tr", {}, el("th", {}, "Almacén"), el("th", { class: "num" }, "Usado"), el("th", { class: "num" }, "Precio sombra"), el("th", {}, "Lectura")));
  A.forEach((a, i) => {
    const usado = r.x[i].reduce((p, q) => p + q, 0);
    const ps = r.precio_sombra_oferta[i];
    const lectura = ps < 0 ? el("span", { class: "tag ok" }, `+1 lote ahorra ${money(-ps)}`) : el("span", { class: "tag" }, "Tiene capacidad libre");
    pso.append(el("tr", {}, el("td", {}, a.nombre), el("td", { class: "num" }, `${fmt(usado)} / ${fmt(a.oferta)}`), el("td", { class: "num" }, money(ps)), el("td", {}, lectura)));
  });
  const psd = $("tbl-ps-de");
  psd.replaceChildren(el("tr", {}, el("th", {}, "Sucursal"), el("th", { class: "num" }, "Demanda"), el("th", { class: "num" }, "Precio sombra"), el("th", {}, "Lectura")));
  S.forEach((s, j) => {
    const ps = r.precio_sombra_demanda[j];
    psd.append(el("tr", {}, el("td", {}, s.nombre), el("td", { class: "num" }, fmt(s.demanda)), el("td", { class: "num" }, money(ps)),
      el("td", {}, el("span", { class: "tag warn" }, `+1 lote cuesta ${money(ps)}`))));
  });

  // Sensibilidad por ruta
  const ts = $("tbl-sens");
  ts.replaceChildren(el("tr", {}, el("th", {}, "Ruta"), el("th", { class: "num" }, "Lotes"), el("th", { class: "num" }, "Costo"),
    el("th", { class: "num" }, "Costo reducido"), el("th", { class: "num" }, "Mínimo"), el("th", { class: "num" }, "Máximo"), el("th", {}, "Estado")));
  A.forEach((a, i) => S.forEach((s, j) => {
    const rg = r.rangos?.[i]?.[j] || {};
    const usada = r.x[i][j] > 0;
    ts.append(el("tr", {},
      el("td", {}, `${a.nombre} → ${s.nombre}`),
      el("td", { class: "num" + (usada ? " pos" : "") }, usada ? fmt(r.x[i][j]) : "–"),
      el("td", { class: "num" }, money(r.costos[i][j])),
      el("td", { class: "num" }, money(r.costo_reducido[i][j])),
      el("td", { class: "num" }, rg.min == null ? "sin límite" : money(rg.min)),
      el("td", { class: "num" }, rg.max == null ? "sin límite" : money(rg.max)),
      el("td", {}, usada ? el("span", { class: "tag ok" }, "En el plan") : el("span", { class: "tag" }, `Entraría si baja ${money(r.costo_reducido[i][j])}`))));
  }));

  // Métodos iniciales
  const tm = $("tbl-met");
  tm.replaceChildren(el("tr", {}, el("th", {}, "Método"), el("th", { class: "num" }, "Costo total"), el("th", { class: "num" }, "Diferencia vs. óptimo"), el("th", { class: "num" }, "%")));
  Object.entries(r.metodos_iniciales).forEach(([k, v]) => tm.append(el("tr", {}, el("td", {}, k), el("td", { class: "num" }, money(v.costo)),
    el("td", { class: "num" }, money(v.diferencia)), el("td", { class: "num" }, fmt(v.pct, 2) + " %"))));

  interpretar(r);
  dibujarMapa(r);
}

function interpretar(r) {
  const A = r.almacenes, S = r.sucursales, ul = $("insights");
  ul.replaceChildren();
  const li = (t) => ul.append(el("li", {}, t));
  li(`El plan óptimo cuesta ${money(r.costo_total)} al mes y usa ${r.x.flat().filter((v) => v > 0).length} rutas.`);
  if (r.ficticio_tipo === "destino") {
    A.forEach((a, i) => r.ficticio[i] > 0 && li(`${a.nombre} queda con ${fmt(r.ficticio[i])} lotes sin enviar (destino ficticio): es el almacén con capacidad sobrante.`));
  } else if (r.ficticio_tipo === "origen") {
    S.forEach((s, j) => r.ficticio[j] > 0 && li(`${s.nombre} queda con ${fmt(r.ficticio[j])} lotes sin surtir: la oferta no alcanza.`));
  }
  const iMax = r.precio_sombra_oferta.indexOf(Math.min(...r.precio_sombra_oferta));
  if (r.precio_sombra_oferta[iMax] < 0)
    li(`Ampliar ${A[iMax].nombre} es lo más rentable: cada lote extra de capacidad reduce el costo en ${money(-r.precio_sombra_oferta[iMax])}.`);
  const jMax = r.precio_sombra_demanda.indexOf(Math.max(...r.precio_sombra_demanda));
  li(`${S[jMax].nombre} es la sucursal más cara de surtir: cada lote adicional de demanda cuesta ${money(r.precio_sombra_demanda[jMax])}.`);
  let mejor = null;
  r.costo_reducido.forEach((f, i) => f.forEach((v, j) => { if (r.x[i][j] === 0 && v > 0 && (!mejor || v < mejor.v)) mejor = { v, i, j }; }));
  if (mejor) li(`La ruta no usada más cercana a entrar es ${A[mejor.i].nombre} → ${S[mejor.j].nombre}: bastaría negociar ${money(mejor.v)} menos por lote.`);
  const v = r.metodos_iniciales["Vogel"], n = r.metodos_iniciales["Esquina noreste"];
  li(`Frente a los métodos manuales, el óptimo ahorra ${money(v.diferencia)} respecto a Vogel y ${money(n.diferencia)} respecto a la esquina noreste.`);
}

// ---------------------------------------------------------------- mapa
let mapa = null, capa = null;
function dibujarMapa(r) {
  const cont = $("map");
  const maxFlujo = Math.max(1, ...r.x.flat());
  if (window.L) {
    if (!mapa) {
      mapa = L.map(cont);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(mapa);
    }
    if (capa) capa.remove();
    capa = L.layerGroup().addTo(mapa);
    const pts = [];
    r.almacenes.forEach((a, i) => r.sucursales.forEach((s, j) => {
      const v = r.x[i][j];
      if (v > 0) L.polyline([[a.lat, a.lng], [s.lat, s.lng]], { color: "#D9771E", weight: 2 + 10 * v / maxFlujo, opacity: .85 })
        .bindTooltip(`${a.nombre} → ${s.nombre}: ${fmt(v)} lotes`).addTo(capa);
    }));
    r.almacenes.forEach((a) => { pts.push([a.lat, a.lng]); L.circleMarker([a.lat, a.lng], { radius: 9, color: "#16223A", fillColor: "#1F5FBF", fillOpacity: 1 }).bindTooltip(a.nombre, { permanent: true, direction: "top" }).addTo(capa); });
    r.sucursales.forEach((s) => { pts.push([s.lat, s.lng]); L.circleMarker([s.lat, s.lng], { radius: 7, color: "#16223A", fillColor: "#FFFFFF", fillOpacity: 1 }).bindTooltip(s.nombre, { permanent: true, direction: "bottom" }).addTo(capa); });
    mapa.fitBounds(pts, { padding: [40, 40] });
    return;
  }
  // Respaldo sin conexión: esquema en SVG
  const nodos = [...r.almacenes, ...r.sucursales];
  const lats = nodos.map((n) => n.lat), lngs = nodos.map((n) => n.lng);
  const W = cont.clientWidth || 700, H = 380, pad = 60;
  const x = (lng) => pad + (lng - Math.min(...lngs)) / ((Math.max(...lngs) - Math.min(...lngs)) || 1) * (W - 2 * pad);
  const y = (lat) => pad + (Math.max(...lats) - lat) / ((Math.max(...lats) - Math.min(...lats)) || 1) * (H - 2 * pad);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", W); svg.setAttribute("height", H);
  const add = (tag, at, txt) => { const e = document.createElementNS(ns, tag); for (const k in at) e.setAttribute(k, at[k]); if (txt) e.textContent = txt; svg.append(e); return e; };
  r.almacenes.forEach((a, i) => r.sucursales.forEach((s, j) => {
    const v = r.x[i][j];
    if (v > 0) {
      add("line", { x1: x(a.lng), y1: y(a.lat), x2: x(s.lng), y2: y(s.lat), stroke: "#D9771E", "stroke-width": 2 + 10 * v / maxFlujo, "stroke-opacity": .85, "stroke-linecap": "round" });
      add("text", { x: (x(a.lng) + x(s.lng)) / 2, y: (y(a.lat) + y(s.lat)) / 2 - 6, "font-size": 12, fill: "#9A4D0B", "text-anchor": "middle", "font-weight": 600 }, fmt(v));
    }
  }));
  r.almacenes.forEach((a) => { add("circle", { cx: x(a.lng), cy: y(a.lat), r: 9, fill: "#1F5FBF", stroke: "#16223A", "stroke-width": 2 }); add("text", { x: x(a.lng), y: y(a.lat) - 14, "font-size": 13, "text-anchor": "middle", "font-weight": 700, fill: "#16223A" }, a.nombre); });
  r.sucursales.forEach((s) => { add("circle", { cx: x(s.lng), cy: y(s.lat), r: 7, fill: "#fff", stroke: "#16223A", "stroke-width": 2 }); add("text", { x: x(s.lng), y: y(s.lat) + 22, "font-size": 12, "text-anchor": "middle", fill: "#16223A" }, s.nombre); });
  cont.replaceChildren(svg);
}

// ---------------------------------------------------------------- CSV
function exportarCSV() {
  const r = estado.resultado;
  if (!r) return;
  const filas = [["Almacen", "Sucursal", "Lotes", "Costo por lote", "Costo"]];
  r.almacenes.forEach((a, i) => r.sucursales.forEach((s, j) => r.x[i][j] > 0 && filas.push([a.nombre, s.nombre, r.x[i][j], r.costos[i][j], r.x[i][j] * r.costos[i][j]])));
  filas.push(["", "", "", "Costo total", r.costo_total]);
  const csv = filas.map((f) => f.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = el("a", { href: URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" })), download: "plan_optiroute.csv" });
  a.click();
}

// ---------------------------------------------------------------- eventos
$("btn-solve").addEventListener("click", optimizar);
$("btn-reset").addEventListener("click", () => cargarBase().catch((e) => aviso(e.message)));
$("btn-costos").addEventListener("click", () => calcularCostos().catch((e) => aviso(e.message)));
$("btn-csv").addEventListener("click", exportarCSV);
$("add-alm").addEventListener("click", () => { estado.almacenes.push({ nombre: `Almacén ${estado.almacenes.length + 1}`, lat: 25.7, lng: -100.3, oferta: 100 }); estado.costos.push(estado.sucursales.map(() => 500)); dibujarEntradas(); });
$("add-suc").addEventListener("click", () => { estado.sucursales.push({ nombre: `Sucursal ${estado.sucursales.length + 1}`, lat: 24.8, lng: -98.8, demanda: 50 }); estado.costos.forEach((f) => f.push(500)); dibujarEntradas(); });
cargarBase().catch((e) => aviso(e.message));
