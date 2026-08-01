// Chat financiero flotante, disponible desde cualquier sección.
//
// Clave del diseño: se monta UNA sola vez colgado de <body>, no dentro de
// #content. El router repinta #content en cada navegación, así que cualquier
// cosa que viviera ahí se destruiría al cambiar de pestaña. Colgando del body
// el panel sobrevive intacto —con su conversación y su estado— al pasar de
// Dashboard a Facturación mensual o a donde sea.
//
// El estado (cerrado / abierto / minimizado) y la conversación se guardan
// además en localStorage, así que también aguantan un F5 o cerrar la app.

import { db } from "../supabase.js";
import { construirLedger, resumenPeriodo, rangoAnio, rangoMes, conIva, estadoEfectivo, conIvaSegunPago } from "../utils/resumen.js";
import { getConfig } from "../utils/config-usuario.js";
import { round2 } from "../utils/invoice-calc.js";
import { escapeHtml } from "./clientes.js";
import { preguntarAsistenteFinanciero, tieneClaveIA } from "../ai/mistral.js";

const CLAVE_ESTADO = "jml_chat_estado";
const CLAVE_HIST = "jml_chat_historial";
const MESES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];

let estado = "cerrado";     // cerrado | abierto | minimizado
let historial = [];
let contexto = null;
let contextoCargado = 0;    // marca de tiempo, para no repetir la consulta
let montado = false;

/* ------------------------------------------------------------ persistencia */

function leerGuardado() {
  estado = localStorage.getItem(CLAVE_ESTADO) || "cerrado";
  try { historial = JSON.parse(localStorage.getItem(CLAVE_HIST) || "[]"); }
  catch { historial = []; }
}

function guardar() {
  localStorage.setItem(CLAVE_ESTADO, estado);
  // Solo los mensajes de verdad: los "pensando…" no tienen sentido guardados.
  try { localStorage.setItem(CLAVE_HIST, JSON.stringify(historial.filter(m => !m.pensando).slice(-40))); }
  catch { /* si no cabe, se pierde: no es crítico */ }
}

export function olvidarChat() {
  historial = [];
  estado = "cerrado";
  contexto = null;
  localStorage.removeItem(CLAVE_HIST);
  localStorage.removeItem(CLAVE_ESTADO);
  document.getElementById("chat-flotante")?.remove();
  document.getElementById("chat-fab")?.remove();
  montado = false;
}

/* ---------------------------------------------------------------- contexto */

// Las cifras que se le pasan a la IA con cada pregunta. Es una versión
// reducida de la que arma la página del Asistente: lo justo para responder
// sobre facturación, gastos, beneficio y cobros pendientes.
async function cargarContexto() {
  if (contexto && Date.now() - contextoCargado < 5 * 60 * 1000) return contexto;

  const [{ data: proyectos }, { data: facturaProyectos }, { data: gastos }, { data: clientes }] = await Promise.all([
    db.from("proyectos").select("*").exec(),
    db.from("factura_proyectos").select("importe,factura_id,proyecto_id,facturas(numero,estado,fecha,tipo)").exec(),
    db.from("gastos").select("*").exec(),
    db.from("clientes").select("id,nombre").exec(),
  ]);

  const ledger = construirLedger(proyectos, facturaProyectos);
  const hoy = new Date();
  const anio = hoy.getFullYear();
  const cfg = getConfig();
  const rAnio = rangoAnio(anio);
  const anual = resumenPeriodo(ledger, gastos, rAnio.desde, rAnio.hasta);
  const rMes = rangoMes(anio, hoy.getMonth());
  const mes = resumenPeriodo(ledger, gastos, rMes.desde, rMes.hasta);

  const pendientes = ledger.filter(f => estadoEfectivo(f) === "emitida");
  const nombres = Object.fromEntries((clientes || []).map(c => [c.id, c.nombre]));

  const porCliente = {};
  ledger.filter(f => (f.fecha || "").startsWith(String(anio))).forEach(f => {
    // Ojo: el cliente cuelga del proyecto, no de la fila del ledger.
    const n = nombres[f.proyecto?.cliente_id] || "sin clasificar";
    porCliente[n] = round2((porCliente[n] || 0) + f.importeBase);
  });

  const porCategoria = {};
  (gastos || []).filter(g => (g.fecha || "").startsWith(String(anio))).forEach(g => {
    const k = g.categoria || "otros";
    porCategoria[k] = round2((porCategoria[k] || 0) + Number(g.importe || 0));
  });

  contexto = {
    fecha_hoy: hoy.toISOString().slice(0, 10),
    anio,
    trimestre_actual: Math.floor(hoy.getMonth() / 3) + 1,
    modelo130_pct_configurado: cfg.modelo130_pct,
    cuota_autonomo_mensual: cfg.cuota_autonomo_importe,
    mes_actual: { facturado_transferencia: mes.transferencia, facturado_efectivo: mes.efectivo },
    anual: {
      facturado_transferencia: anual.transferencia,
      facturado_efectivo: anual.efectivo,
      gastos_deducibles: anual.gastosDeducibles,
      gastos_no_deducibles: anual.gastosNoDeducibles,
      beneficio_fiscal: anual.beneficioFiscal,
      beneficio_real: anual.beneficioReal,
    },
    pendiente_de_cobro: {
      importe_con_iva: round2(pendientes.reduce((s, f) => s + conIvaSegunPago(f.importeBase, f.proyecto.forma_pago), 0)),
      num_proyectos: pendientes.length,
    },
    facturacion_por_mes: MESES.map((m, i) => {
      const r = rangoMes(anio, i);
      const p = resumenPeriodo(ledger, gastos, r.desde, r.hasta);
      return { mes: m, facturado: round2(p.transferencia + p.efectivo) };
    }),
    facturado_por_cliente_anio: porCliente,
    gastos_por_categoria_anio: porCategoria,
  };
  contextoCargado = Date.now();
  return contexto;
}

/* ----------------------------------------------------------------- formato */

// La IA responde en Markdown. Se escapa PRIMERO el HTML y solo después se
// aplica el formato, para que un < o un > del texto no inyecte etiquetas.
function formatear(texto) {
  return escapeHtml(texto)
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s.,;:)!?]|$)/g, "$1<em>$2</em>")
    .replace(/`([^`\n]+?)`/g, "<code>$1</code>")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^\s*#{1,6}\s+(.+)$/gm, "<strong>$1</strong>");
}

/* ------------------------------------------------------------------- monta */

export function montarChatFlotante() {
  if (montado) return;
  montado = true;
  leerGuardado();

  const $fab = document.createElement("button");
  $fab.id = "chat-fab";
  $fab.className = "chat-fab";
  $fab.type = "button";
  $fab.title = "Abrir el chat financiero";
  $fab.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-3.3-.5L3 21l1.6-4.4A8.2 8.2 0 0 1 3.6 11.5 8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z"/></svg>
    <span>Preguntar</span>`;

  const $panel = document.createElement("aside");
  $panel.id = "chat-flotante";
  $panel.className = "chat-panel";
  $panel.innerHTML = `
    <header class="chat-cab">
      <div class="chat-cab-txt">
        <strong>Chat financiero</strong>
        <small>Responde con tus cifras reales</small>
      </div>
      <div class="chat-cab-btns">
        <button type="button" data-min title="Minimizar">–</button>
        <button type="button" data-cerrar title="Cerrar">×</button>
      </div>
    </header>
    <div class="chat-cuerpo" data-mensajes></div>
    <form class="chat-pie" data-form>
      <input type="text" data-input placeholder="Pregunta sobre tu facturación, gastos…" autocomplete="off">
      <button class="btn btn-primary" type="submit">Enviar</button>
    </form>
    <p class="chat-nota">Respuestas orientativas — confírmalo con tu gestoría.</p>
  `;

  document.body.appendChild($fab);
  document.body.appendChild($panel);

  const $mensajes = $panel.querySelector("[data-mensajes]");
  const $input = $panel.querySelector("[data-input]");

  function aplicarEstado() {
    $panel.classList.toggle("abierto", estado === "abierto");
    $panel.classList.toggle("minimizado", estado === "minimizado");
    // El botón flotante solo estorba cuando el panel ya está a la vista.
    $fab.hidden = estado !== "cerrado";
    guardar();
  }

  function pintar() {
    $mensajes.innerHTML = historial.length
      // Sin saltos ni sangría dentro del <div>: la burbuja usa white-space
      // pre-wrap, así que cualquier espacio del propio HTML se vería como un
      // hueco raro delante del texto.
      ? historial.map(m => `<div class="chat-burbuja ${m.rol === "usuario" ? "mia" : "suya"}${m.error ? " err" : ""}">${m.rol === "usuario" ? escapeHtml(m.texto) : formatear(m.texto)}</div>`).join("")
      : `<p class="chat-vacio">Pregúntame lo que quieras sobre tu facturación, gastos, clientes o el Modelo 130.</p>`;
    $mensajes.scrollTop = $mensajes.scrollHeight;
  }

  function abrir() { estado = "abierto"; aplicarEstado(); pintar(); $input.focus(); }

  $fab.addEventListener("click", abrir);
  // Con el panel minimizado, su cabecera funciona como pestañita: al pulsarla
  // vuelve a desplegarse.
  $panel.querySelector(".chat-cab").addEventListener("click", (e) => {
    if (estado === "minimizado" && !e.target.closest("button")) abrir();
  });
  $panel.querySelector("[data-min]").addEventListener("click", () => {
    estado = estado === "minimizado" ? "abierto" : "minimizado";
    aplicarEstado();
  });
  $panel.querySelector("[data-cerrar]").addEventListener("click", () => {
    estado = "cerrado";
    aplicarEstado();
  });

  $panel.querySelector("[data-form]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pregunta = $input.value.trim();
    if (!pregunta) return;
    if (!tieneClaveIA()) {
      historial.push({ rol: "ia", texto: "Falta la clave de IA. Añádela en Configuración → IA.", error: true });
      pintar(); guardar();
      return;
    }

    historial.push({ rol: "usuario", texto: pregunta });
    historial.push({ rol: "ia", texto: "Pensando…", pensando: true });
    $input.value = "";
    pintar();

    try {
      const ctx = await cargarContexto();
      const previos = historial.filter(m => !m.pensando && !m.error).slice(0, -1);
      const respuesta = await preguntarAsistenteFinanciero(pregunta, ctx, previos);
      historial = historial.filter(m => !m.pensando);
      historial.push({ rol: "ia", texto: respuesta });
    } catch (err) {
      historial = historial.filter(m => !m.pensando);
      historial.push({ rol: "ia", texto: err.message || "No he podido responder.", error: true });
    }
    pintar();
    guardar();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && estado === "abierto") { estado = "minimizado"; aplicarEstado(); }
  });

  aplicarEstado();
  pintar();
}
