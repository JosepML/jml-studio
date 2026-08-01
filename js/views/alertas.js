// Campanita de alertas de la barra superior.
//
// Antes esto era media página del Asistente. Se ha traído a la barra porque
// son avisos que interesan estés donde estés (cobros que se retrasan, gastos
// fijos sin registrar, proyectos sin cliente), no algo que uno vaya a buscar
// entrando en una sección.
//
// Igual que el chat flotante, se monta UNA vez fuera de #content para que no
// se destruya al navegar.

import { db } from "../supabase.js";
import { eur, dateEs, todayIso } from "../utils/format.js";
import { construirLedger, rangoMes, conIva, estadoEfectivo, conIvaSegunPago } from "../utils/resumen.js";
import { escapeHtml, escapeAttr } from "./clientes.js";

const CLIENTE_GENERICO = "por clasificar";
const CLAVE_DESCARTADAS = "jml_alertas_descartadas";
let montado = false;

// Avisos que Josep ha descartado a mano. Se guardan por identificador
// estable (proyecto, gasto, número de factura…) y NO por el texto: así el
// aviso de un cobro no reaparece solo porque hayan pasado más días y el
// mensaje diga otra cifra. Si la situación se arregla de verdad, el aviso
// deja de generarse y el descarte simplemente sobra.
function leerDescartadas() {
  try { return new Set(JSON.parse(localStorage.getItem(CLAVE_DESCARTADAS) || "[]")); }
  catch { return new Set(); }
}
function guardarDescartadas(set) {
  localStorage.setItem(CLAVE_DESCARTADAS, JSON.stringify([...set]));
}

/**
 * Recalcula la lista de avisos a partir de los datos reales.
 * Cada aviso lleva el enlace a la pantalla donde se arregla.
 */
export async function calcularAlertas() {
  const [{ data: proyectos }, { data: facturaProyectos }, { data: gastos }, { data: clientes }] = await Promise.all([
    db.from("proyectos").select("*").exec(),
    db.from("factura_proyectos").select("importe,factura_id,proyecto_id,facturas(numero,estado,fecha,tipo)").exec(),
    db.from("gastos").select("*").exec(),
    db.from("clientes").select("id,nombre").exec(),
  ]);

  const clientesMap = Object.fromEntries((clientes || []).map(c => [c.id, c.nombre]));
  const ledger = construirLedger(proyectos, facturaProyectos);
  const hoy = new Date();
  const anio = hoy.getFullYear();
  const hoyIso = todayIso();
  const rMes = rangoMes(anio, hoy.getMonth());
  const alertas = [];
  const diasDesde = (iso) => Math.floor((new Date(hoyIso) - new Date(iso)) / 86400000);

  // Emitidas hace más de 30 días y todavía sin marcar como cobradas.
  ledger.filter(f => estadoEfectivo(f) === "emitida" && f.fecha && diasDesde(f.fecha) > 30)
    .sort((a, b) => diasDesde(b.fecha) - diasDesde(a.fecha))
    .forEach(f => alertas.push({
      id: `cobro:${f.proyecto.id}`,
      tipo: "cobro",
      texto: `"${f.proyecto.nombre}" (${clientesMap[f.proyecto.cliente_id] || "—"}) lleva ${diasDesde(f.fecha)} días emitido sin marcarse como pagado — ${eur(conIvaSegunPago(f.importeBase, f.proyecto.forma_pago))}.`,
      href: "#/mensual",
    }));

  (proyectos || []).filter(p => (clientesMap[p.cliente_id] || "").toLowerCase().includes(CLIENTE_GENERICO))
    .forEach(p => alertas.push({
      id: `cliente-generico:${p.id}`,
      tipo: "cliente",
      texto: `"${p.nombre}" está bajo un cliente genérico ("${clientesMap[p.cliente_id]}") — créale una ficha propia si quieres tener sus datos.`,
      href: `#/proyectos/${p.id}`,
    }));

  (gastos || []).filter(g => g.categoria === "combustible" && Number(g.iva_soportado || 0) === 0 && g.deducible !== false)
    .forEach(g => alertas.push({
      id: `combustible:${g.id}`,
      tipo: "gasto",
      texto: `Gasto de combustible "${g.concepto}" (${dateEs(g.fecha)}) no tiene el IVA soportado desglosado — revísalo para no perder deducción.`,
      href: "#/gastos",
    }));

  (gastos || []).filter(g => g.es_amortizable && g.meses_amortizacion && g.fecha_inicio_amortizacion).forEach(g => {
    const inicio = new Date(g.fecha_inicio_amortizacion + "T00:00:00");
    const fin = new Date(inicio.getFullYear(), inicio.getMonth() + g.meses_amortizacion, inicio.getDate());
    const dias = Math.floor((fin - hoy) / 86400000);
    if (dias > 0 && dias <= 60) alertas.push({
      id: `amortizacion:${g.id}`,
      tipo: "amortizacion",
      texto: `El bien "${g.concepto}" termina de amortizarse el ${dateEs(fin.toISOString().slice(0, 10))}.`,
      href: "#/gastos",
    });
  });

  (proyectos || []).filter(p => !p.cliente_id).forEach(p => alertas.push({
    id: `sin-cliente:${p.id}`,
    tipo: "cliente",
    texto: `"${p.nombre}" no tiene cliente asignado — asígnaselo para poder facturarlo correctamente.`,
    href: `#/proyectos/${p.id}`,
  }));

  // Un mismo número de factura apuntando a clientes distintos: casi siempre
  // es un error de tecleo al asignarlo desde Facturación mensual.
  {
    const porNumero = {};
    (facturaProyectos || []).forEach(fp => {
      if (!fp.facturas || fp.facturas.tipo !== "factura") return;
      const cli = (proyectos || []).find(p => p.id === fp.proyecto_id)?.cliente_id;
      porNumero[fp.facturas.numero] = porNumero[fp.facturas.numero] || new Set();
      if (cli) porNumero[fp.facturas.numero].add(cli);
    });
    Object.entries(porNumero).filter(([, s]) => s.size > 1).forEach(([num]) => alertas.push({
      id: `factura-dup:${num}`,
      tipo: "factura",
      texto: `La factura ${num} agrupa proyectos de varios clientes distintos — revísala, seguramente sea un error de número.`,
      href: "#/mensual",
    }));
  }

  // Gastos fijos que aparecen en meses anteriores pero no en el mes en curso.
  {
    const mesIdx = hoy.getMonth();
    const limpio = (c) => c.replace(/[\d\/\-]+$/, "").trim();
    const antes = new Set();
    (gastos || []).filter(g => g.tipo === "fijo" && g.fecha).forEach(g => {
      const f = new Date(g.fecha + "T00:00:00");
      if (f.getFullYear() === anio && f.getMonth() < mesIdx) antes.add(limpio(g.concepto));
    });
    const esteMes = new Set((gastos || [])
      .filter(g => g.tipo === "fijo" && g.fecha && g.fecha.startsWith(rMes.desde.slice(0, 7)))
      .map(g => limpio(g.concepto)));
    if (mesIdx > 0) {
      Array.from(antes).filter(c => !esteMes.has(c)).forEach(c => alertas.push({
        id: `fijo:${rMes.desde.slice(0, 7)}:${c}`,
        tipo: "gasto",
        texto: `No hay ningún gasto fijo "${c}" registrado este mes — si ya lo has pagado, no olvides añadirlo.`,
        href: "#/gastos",
      }));
    }
  }

  const descartadas = leerDescartadas();
  return alertas.filter(a => !descartadas.has(a.id));
}

/** Cuántos avisos hay silenciados ahora mismo. */
export function numDescartadas() {
  return leerDescartadas().size;
}

const ICONOS = {
  cobro: "€",
  cliente: "◍",
  gasto: "▣",
  amortizacion: "◷",
  factura: "◆",
};

export function olvidarAlertas() {
  document.getElementById("campana-wrap")?.remove();
  montado = false;
}

export function montarCampana() {
  if (montado) return;
  const $topbar = document.querySelector(".topbar");
  if (!$topbar) return;
  montado = true;

  const $wrap = document.createElement("div");
  $wrap.id = "campana-wrap";
  $wrap.className = "campana-wrap";
  $wrap.innerHTML = `
    <button class="campana" type="button" data-btn title="Avisos pendientes">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8.5a6 6 0 1 0-12 0c0 6-2.2 7.5-2.2 7.5h16.4S18 14.5 18 8.5z"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/></svg>
      <span class="campana-num" data-num hidden>0</span>
    </button>
    <div class="campana-panel" data-panel hidden>
      <header>
        <strong>Avisos</strong>
        <button type="button" data-recargar title="Volver a comprobar">⟳</button>
      </header>
      <div class="campana-lista" data-lista><p class="campana-vacio">Comprobando…</p></div>
      <footer class="campana-pie" data-pie hidden>
        <button type="button" data-restaurar>Restaurar los descartados</button>
      </footer>
    </div>`;
  $topbar.appendChild($wrap);

  const $btn = $wrap.querySelector("[data-btn]");
  const $num = $wrap.querySelector("[data-num]");
  const $panel = $wrap.querySelector("[data-panel]");
  const $lista = $wrap.querySelector("[data-lista]");

  async function refrescar() {
    $lista.innerHTML = `<p class="campana-vacio">Comprobando…</p>`;
    try {
      const alertas = await calcularAlertas();
      ponerNumero(alertas.length);
      $lista.innerHTML = alertas.length
        ? alertas.map(a => `<div class="campana-item"><a href="${escapeAttr(a.href)}"><i class="campana-ico ${escapeAttr(a.tipo)}">${ICONOS[a.tipo] || "•"}</i><span>${escapeHtml(a.texto)}</span></a><button type="button" class="campana-x" data-descartar="${escapeAttr(a.id)}" title="Descartar este aviso">×</button></div>`).join("")
        : `<p class="campana-vacio">${numDescartadas() ? "No queda ningún aviso a la vista." : "Todo en orden. No hay nada pendiente."}</p>`;
      pintarPie();
    } catch (e) {
      $lista.innerHTML = `<p class="campana-vacio">No se han podido cargar los avisos.</p>`;
    }
  }

  const $pie = $wrap.querySelector("[data-pie]");

  function pintarPie() {
    const n = numDescartadas();
    $pie.hidden = n === 0;
    $pie.querySelector("[data-restaurar]").textContent = `Restaurar los descartados (${n})`;
  }

  function ponerNumero(n) {
    $num.hidden = n === 0;
    $num.textContent = n > 99 ? "99+" : n;
  }

  // Descartar y restaurar se resuelven aquí, delegando: la lista se repinta
  // entera en cada refresco, así que no se pueden enganchar oyentes a cada fila.
  $panel.addEventListener("click", (e) => {
    const x = e.target.closest("[data-descartar]");
    if (!x) return;
    e.preventDefault();
    e.stopPropagation();
    const set = leerDescartadas();
    set.add(x.dataset.descartar);
    guardarDescartadas(set);
    refrescar();
  });

  $wrap.querySelector("[data-restaurar]").addEventListener("click", (e) => {
    e.stopPropagation();
    localStorage.removeItem(CLAVE_DESCARTADAS);
    refrescar();
  });

  $btn.addEventListener("click", (e) => {
    e.stopPropagation();
    $panel.hidden = !$panel.hidden;
    if (!$panel.hidden) refrescar();
  });
  $wrap.querySelector("[data-recargar]").addEventListener("click", (e) => { e.stopPropagation(); refrescar(); });
  $panel.addEventListener("click", (e) => { if (e.target.closest("a")) $panel.hidden = true; });
  document.addEventListener("click", () => { $panel.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $panel.hidden = true; });

  // Primera comprobación en segundo plano, solo para pintar el contador.
  calcularAlertas().then(a => ponerNumero(a.length)).catch(() => {});
}
