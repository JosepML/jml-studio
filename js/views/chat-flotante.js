// Chat financiero flotante, disponible desde cualquier sección.
//
// Clave del diseño: se monta UNA sola vez colgado de <body>, no dentro de
// #content. El router repinta #content en cada navegación, así que cualquier
// cosa que viviera ahí se destruiría al cambiar de pestaña. Colgando del body
// el panel sobrevive intacto —con su conversación y su estado— al pasar de
// Dashboard a Facturación mensual o a donde sea.
//
// El estado de la ventana se guarda en localStorage. Las conversaciones y sus
// mensajes viven en Supabase para poder recuperar varios chats desde cualquier
// dispositivo.

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
let conversaciones = [];
let conversacionActual = null;
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
}

async function cargarConversaciones() {
  const { data, error } = await db.from("chat_conversaciones").select("id,titulo,created_at,updated_at").order("updated_at", { ascending: false }).limit(30).exec();
  if (error) throw new Error(error);
  conversaciones = data || [];
  if (!conversaciones.length) {
    // Migración transparente del único historial antiguo guardado en el navegador.
    const antiguos = historial.filter(m => !m.pensando && !m.error && m.texto);
    if (antiguos.length) {
      const nueva = await crearConversacion("Conversación anterior");
      await guardarMensajes(nueva.id, antiguos);
      localStorage.removeItem(CLAVE_HIST);
      conversaciones = [nueva];
    }
  }
  const primera = conversaciones[0];
  if (primera) await seleccionarConversacion(primera.id);
  else historial = [];
  localStorage.removeItem(CLAVE_HIST);
}

async function crearConversacion(titulo = "Nueva conversación") {
  const { data, error } = await db.from("chat_conversaciones").insert({ titulo }).exec();
  if (error) throw new Error(error);
  return Array.isArray(data) ? data[0] : data;
}

async function guardarMensajes(conversacionId, mensajes) {
  for (const m of mensajes) {
    const { error } = await db.from("chat_mensajes").insert({ conversacion_id: conversacionId, rol: m.rol, contenido: m.texto }).exec();
    if (error) throw new Error(error);
  }
  await db.from("chat_conversaciones").update({ updated_at: new Date().toISOString() }).eq("id", conversacionId).exec();
}

async function seleccionarConversacion(id) {
  conversacionActual = id;
  const { data, error } = await db.from("chat_mensajes").select("rol,contenido,created_at").eq("conversacion_id", id).order("created_at").limit(100).exec();
  if (error) throw new Error(error);
  historial = (data || []).map(m => ({ rol: m.rol, texto: m.contenido }));
}

export function olvidarChat() {
  historial = [];
  conversaciones = [];
  conversacionActual = null;
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
  $panel.setAttribute("role", "dialog");
  $panel.setAttribute("aria-label", "Chat financiero");
  $panel.innerHTML = `
    <header class="chat-cab">
      <div class="chat-cab-txt">
        <strong>Chat financiero</strong>
        <small>Responde con tus cifras reales</small>
      </div>
      <div class="chat-cab-btns">
        <button type="button" data-min title="Minimizar" aria-label="Minimizar chat">–</button>
        <button type="button" data-cerrar title="Cerrar" aria-label="Cerrar chat">×</button>
      </div>
    </header>
    <div class="chat-historial">
      <select data-conversacion aria-label="Conversación actual"><option>Cargando conversaciones…</option></select>
      <button type="button" data-nueva title="Nueva conversación" aria-label="Nueva conversación">+</button>
    </div>
    <div class="chat-cuerpo" data-mensajes></div>
    <form class="chat-pie" data-form>
      <input type="text" data-input aria-label="Pregunta al chat financiero" placeholder="Pregunta sobre tu facturación, gastos…" autocomplete="off">
      <button class="btn btn-primary" type="submit">Enviar</button>
    </form>
    <p class="chat-nota">Respuestas orientativas — confírmalo con tu gestoría.</p>
  `;

  document.body.appendChild($fab);
  document.body.appendChild($panel);

  const $mensajes = $panel.querySelector("[data-mensajes]");
  const $input = $panel.querySelector("[data-input]");
  const $conversacion = $panel.querySelector("[data-conversacion]");

  function pintarConversaciones() {
    $conversacion.innerHTML = conversaciones.length
      ? conversaciones.map(c => `<option value="${escapeHtml(c.id)}" ${c.id === conversacionActual ? "selected" : ""}>${escapeHtml(c.titulo || "Nueva conversación")}</option>`).join("")
      : `<option value="">Sin conversaciones todavía</option>`;
  }

  function aplicarEstado() {
    $panel.classList.toggle("abierto", estado === "abierto");
    $panel.classList.toggle("minimizado", estado === "minimizado");
    // El botón flotante solo estorba cuando el panel ya está a la vista.
    $fab.hidden = estado !== "cerrado";
    guardar();
  }

  function pintar() {
    pintarConversaciones();
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
  $conversacion.addEventListener("change", async () => {
    try {
      await seleccionarConversacion($conversacion.value);
      pintar();
    } catch (err) {
      historial = [{ rol: "ia", texto: err.message || "No se ha podido cargar la conversación.", error: true }];
      pintar();
    }
  });
  $panel.querySelector("[data-nueva]").addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      const nueva = await crearConversacion();
      conversaciones = [nueva, ...conversaciones];
      conversacionActual = nueva.id;
      historial = [];
      pintar();
      $input.focus();
    } catch (err) {
      historial = [{ rol: "ia", texto: err.message || "No se ha podido crear un chat nuevo.", error: true }];
      pintar();
    }
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

    if (!conversacionActual) {
      try {
        const nueva = await crearConversacion(pregunta.slice(0, 42));
        conversaciones = [nueva, ...conversaciones];
        conversacionActual = nueva.id;
      } catch (err) {
        historial.push({ rol: "ia", texto: err.message || "No se ha podido guardar el chat.", error: true });
        pintar();
        return;
      }
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
      await guardarMensajes(conversacionActual, [
        { rol: "usuario", texto: pregunta },
        { rol: "ia", texto: respuesta },
      ]);
      const c = conversaciones.find(x => x.id === conversacionActual);
      if (c) {
        c.updated_at = new Date().toISOString();
        if (!c.titulo || c.titulo === "Nueva conversación") {
          c.titulo = pregunta.slice(0, 42);
          await db.from("chat_conversaciones").update({ titulo: c.titulo }).eq("id", conversacionActual).exec();
        }
      }
      conversaciones.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
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
  cargarConversaciones().then(pintar).catch((err) => {
    // La app sigue siendo utilizable si una sesión antigua aún no tiene las
    // tablas nuevas: mostramos el historial local y dejamos constancia clara.
    historial = [{ rol: "ia", texto: "No se ha podido cargar el historial de chats. Puedes seguir usando el chat en esta sesión.", error: true }];
    pintar();
    console.warn("Historial de chat no disponible", err);
  });
}
