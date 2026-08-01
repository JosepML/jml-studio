import { db } from "../supabase.js";
import { calcularFactura, desglosarLinea, aplicarDescuentoGlobal, round2 } from "../utils/invoice-calc.js";
import { ESTADOS_FACTURA, ESTADOS_PRESUPUESTO, eur, dateEs, todayIso, CATEGORIAS_SERVICIO } from "../utils/format.js";
import { escapeHtml, escapeAttr } from "./clientes.js";
import { CONFIG_NEGOCIO } from "../utils/config-negocio.js";
import { crearFacturaPdf, crearPresupuestoPdf, cargarLogoDataUrl } from "../utils/pdf-documentos.js";
import { mejorarDescripcionConIA, tieneClaveGemini } from "../ai/gemini.js";
import { toastOk, toastError, confirmar, confirmarBorrado, skeletonTabla } from "../utils/ui.js";
import { listarCondiciones, crearCondicion, borrarCondicion, textosPorDefecto, textosFijasDeGrupo, GRUPOS_CONDICION } from "../utils/condiciones.js";
import { listarServicios, crearServicio, etiquetaServicio, servicioALinea } from "../utils/servicios.js";

const EMISOR = CONFIG_NEGOCIO.emisor;

// Campos de facturación del cliente que son obligatorios en una factura.
// Vive a nivel de módulo porque lo necesitan DOS sitios: el editor (para el
// aviso antes de exportar) y el icono de descarga rápida del listado.
export function faltanDatosFacturacion(cliente) {
  if (!cliente) return ["cliente sin seleccionar"];
  const faltan = [];
  if (!String(cliente.nombre || "").trim()) faltan.push("nombre");
  if (!String(cliente.nif || "").trim()) faltan.push("NIF/CIF");
  if (!String(cliente.direccion || "").trim()) faltan.push("dirección fiscal");
  return faltan;
}
const MARCA_BORRADOR = "BORRADOR — SIN VALIDEZ FISCAL";

const ICONO_DESCARGA = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7.2 10.2 12 15l4.8-4.8"/><path d="M4.5 19.5h15"/></svg>`;

// --- Facturas (documentos tipo="factura") ---
export async function renderFacturacion(container, param) {
  return renderSeccion(container, param, {
    tipo: "factura",
    volverA: "#/facturacion",
    tituloSingular: "factura",
    tituloPlural: "Facturas",
    nuevoLabel: "+ Nueva factura",
    estados: ESTADOS_FACTURA,
  });
}

// --- Presupuestos (documentos tipo="presupuesto") — sección totalmente
// separada de Facturas: no comparten numeración ni afectan al balance
// facturado, aunque vivan en la misma tabla por debajo. ---
export async function renderPresupuestos(container, param) {
  return renderSeccion(container, param, {
    tipo: "presupuesto",
    volverA: "#/presupuestos",
    tituloSingular: "presupuesto",
    tituloPlural: "Presupuestos",
    nuevoLabel: "+ Nuevo presupuesto",
    estados: ESTADOS_PRESUPUESTO,
  });
}

async function renderSeccion(container, param, cfg) {
  if (param && param.startsWith("nuevo-desde-proyecto:")) return renderEditor(container, { proyectoId: param.split(":")[1], tipoDefecto: cfg.tipo, volverA: cfg.volverA });
  if (param === "nuevo") return renderEditor(container, { tipoDefecto: cfg.tipo, volverA: cfg.volverA });
  if (param) return renderEditor(container, { facturaId: param, volverA: cfg.volverA });
  return renderLista(container, cfg);
}

async function renderLista(container, cfg) {
  const [{ data: todos, error }, { data: clientes }] = await Promise.all([
    db.from("facturas").select("*").order("fecha", { ascending: false }).exec(),
    db.from("clientes").select("id,nombre,nif,direccion").exec(),
  ]);
  if (error) { container.innerHTML = `<p class="muted">Error: ${error}</p>`; return; }
  const clientesMap = Object.fromEntries((clientes || []).map(c => [c.id, c]));
  // Orden del listado: por número, el más alto arriba. Antes iba por fecha, y
  // como Josep emite varios el mismo día el orden salía arbitrario (y al
  // revés de como los piensa: el último es el de arriba). El secuencial manda;
  // la fecha solo desempata cuando un número no encaja con el formato.
  const documentos = (todos || []).filter(f => f.tipo === cfg.tipo).sort((a, b) => {
    const na = secuencialDe(a.numero), nb = secuencialDe(b.numero);
    if (na != null && nb != null && na !== nb) return nb - na;
    if (na != null && nb == null) return -1;
    if (na == null && nb != null) return 1;
    return String(b.fecha || "").localeCompare(String(a.fecha || ""));
  });

  const anio = new Date().getFullYear();
  let kpisHtml = "";
  let avisosIntegridad = [];

  if (cfg.tipo === "factura") {
    const totalFacturadoAnio = documentos.filter(f => (f.fecha || "").startsWith(String(anio))).reduce((s, f) => s + Number(f.total || 0), 0);
    const sinCobrar = documentos.filter(f => f.estado !== "pagada" && f.estado !== "vencida").length;
    const vencidas = documentos.filter(f => f.estado === "vencida").length;
    kpisHtml = `
      <div class="card kpi"><div class="label">Facturas ${anio}</div><div class="value">${documentos.filter(f=>(f.fecha||"").startsWith(String(anio))).length}</div></div>
      <div class="card kpi"><div class="label">Facturado ${anio}</div><div class="value">${eur(totalFacturadoAnio)}</div></div>
      <div class="card kpi"><div class="label">Sin cobrar</div><div class="value" style="color:var(--orange-fg)">${sinCobrar}</div></div>
      <div class="card kpi"><div class="label">Vencidas</div><div class="value" style="color:${vencidas ? "var(--red-fg,#B4453A)" : "var(--text)"}">${vencidas}</div></div>`;

    // Integridad de la numeración (serie correlativa, sin huecos ni
    // duplicados) — solo avisa, no bloquea nada.
    const numerosPorAnio = {};
    documentos.forEach(f => {
      const y = (f.fecha || "").slice(0, 4);
      if (!y) return;
      (numerosPorAnio[y] ||= []).push(f.numero);
    });
    Object.entries(numerosPorAnio).forEach(([y, numeros]) => {
      const conteo = {};
      numeros.forEach(n => { conteo[n] = (conteo[n] || 0) + 1; });
      const duplicados = Object.entries(conteo).filter(([, c]) => c > 1).map(([n]) => n);
      if (duplicados.length) avisosIntegridad.push(`${y}: número${duplicados.length > 1 ? "s" : ""} repetido${duplicados.length > 1 ? "s" : ""} ${duplicados.join(", ")}`);
      const secuenciales = numeros.map(n => parseInt(n, 10)).filter(n => !isNaN(n)).sort((a, b) => a - b);
      const huecos = [];
      for (let i = 1; i < secuenciales.length; i++) {
        if (secuenciales[i] - secuenciales[i - 1] > 1) {
          for (let g = secuenciales[i - 1] + 1; g < secuenciales[i]; g++) huecos.push(String(g).padStart(2, "0") + "-" + y);
        }
      }
      if (huecos.length) avisosIntegridad.push(`${y}: falta${huecos.length > 1 ? "n" : ""} ${huecos.join(", ")}`);
    });
  } else {
    const abiertos = documentos.filter(f => f.estado === "borrador" || f.estado === "emitida").length;
    const aceptadosAnio = documentos.filter(f => f.estado === "pagada" && (f.fecha || "").startsWith(String(anio))).length;
    const valorAbierto = documentos.filter(f => f.estado === "borrador" || f.estado === "emitida").reduce((s, f) => s + Number(f.total || 0), 0);
    kpisHtml = `
      <div class="card kpi"><div class="label">Presupuestos ${anio}</div><div class="value">${documentos.filter(f=>(f.fecha||"").startsWith(String(anio))).length}</div></div>
      <div class="card kpi"><div class="label">Abiertos</div><div class="value" style="color:var(--orange-fg)">${abiertos}</div></div>
      <div class="card kpi"><div class="label">Valor pendiente de aceptar</div><div class="value">${eur(valorAbierto)}</div></div>
      <div class="card kpi"><div class="label">Aceptados ${anio}</div><div class="value" style="color:var(--green-fg)">${aceptadosAnio}</div></div>`;
  }

  container.innerHTML = `
    ${documentos.length ? `<div class="grid grid-4" style="margin-bottom:20px;">${kpisHtml}</div>` : ""}

    ${avisosIntegridad.length ? `<div class="ai-banner" style="border-left-color:var(--orange-fg); background:var(--orange-bg); color:var(--orange-fg);">⚠️ Revisa la numeración: ${avisosIntegridad.map(escapeHtml).join(" · ")}</div>` : ""}

    <div class="card">
      ${documentos.length ? `
      <div class="toolbar">
        <input id="f-buscar" type="text" placeholder="Buscar por número o cliente…" style="flex:1; min-width:220px;">
        <div class="toolbar-filters">
          <select id="f-estado-filtro">
            <option value="">Todos los estados</option>
            ${Object.entries(cfg.estados).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}
          </select>
          <button class="btn btn-primary" id="btn-nueva">${cfg.nuevoLabel}</button>
        </div>
      </div>` : ""}
      <div id="facturas-list">${skeletonTabla(6)}</div>
    </div>`;

  container.querySelector("#btn-nueva")?.addEventListener("click", () => location.hash = `${cfg.volverA}/nuevo`);

  const $list = container.querySelector("#facturas-list");
  const $buscar = container.querySelector("#f-buscar");
  const $estadoFiltro = container.querySelector("#f-estado-filtro");

  function pintar() {
    const q = ($buscar?.value || "").trim().toLowerCase();
    const estadoSel = $estadoFiltro?.value || "";
    const filtradas = documentos.filter(f => {
      if (estadoSel && f.estado !== estadoSel) return false;
      if (q) {
        const cliente = (clientesMap[f.cliente_id]?.nombre || "").toLowerCase();
        if (!f.numero.toLowerCase().includes(q) && !cliente.includes(q)) return false;
      }
      return true;
    });

    if (!documentos.length) {
      // Estado vacío: sin KPIs a cero ni buscador (los oculta el markup de
      // arriba). Cuatro tarjetas con 0 € no aportan nada y hacían parecer que
      // faltaban datos; aquí lo único útil es la llamada a la acción.
      $list.innerHTML = `<div class="empty-state">Todavía no hay ${cfg.tituloPlural.toLowerCase()}.<br><button class="btn btn-primary" id="btn-nueva-vacio">${cfg.nuevoLabel}</button></div>`;
      $list.querySelector("#btn-nueva-vacio")?.addEventListener("click", () => location.hash = `${cfg.volverA}/nuevo`);
      return;
    }
    if (!filtradas.length) { $list.innerHTML = `<div class="empty-state">Ningún documento coincide con la búsqueda.</div>`; return; }

    $list.innerHTML = `<table>
      <thead><tr><th>Nº</th><th>Cliente</th><th>Fecha</th><th class="money">Total</th><th>Estado</th><th></th></tr></thead>
      <tbody>${filtradas.map(f => `
        <tr class="clickable" data-id="${f.id}">
          <td><strong>${escapeHtml(f.numero)}</strong></td>
          <td>${escapeHtml(clientesMap[f.cliente_id]?.nombre || "—")}</td>
          <td>${dateEs(f.fecha)}</td>
          <td class="money">${eur(f.total)}</td>
          <td><span class="badge" style="background:${cfg.estados[f.estado]?.bg};color:${cfg.estados[f.estado]?.fg}">${cfg.estados[f.estado]?.label || f.estado}</span></td>
          <td class="row-actions"><button class="icon-btn btn-descarga-rapida" data-id="${f.id}" type="button" title="Descargar PDF">${ICONO_DESCARGA}</button></td>
        </tr>`).join("")}</tbody></table>`;

    $list.querySelectorAll("tr[data-id]").forEach(tr => tr.addEventListener("click", () => location.hash = `${cfg.volverA}/${tr.dataset.id}`));
    $list.querySelectorAll(".btn-descarga-rapida").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const doc = documentos.find(d => d.id === btn.dataset.id);
        if (!doc) return;
        // Misma protección que en el editor: si al cliente le faltan datos
        // fiscales, el PDF sale marcado como borrador y se avisa.
        const cliente = clientesMap[doc.cliente_id];
        const faltan = doc.tipo === "factura" ? faltanDatosFacturacion(cliente) : [];
        if (faltan.length) toastError(`Previsualización de ${doc.numero}: faltan ${faltan.join(", ")} del cliente.`);
        btn.disabled = true;
        await descargarPdfDocumento({ ...doc, marcaAgua: faltan.length ? MARCA_BORRADOR : null }, cliente);
        btn.disabled = false;
      });
    });
  }

  $buscar?.addEventListener("input", pintar);
  $estadoFiltro?.addEventListener("change", pintar);
  pintar();
}

// Mantiene factura_proyectos en sincronía con las líneas de la factura: cada
// línea puede estar (opcionalmente) asignada a un proyecto; agrupamos por
// proyecto y guardamos el importe correspondiente. Esto permite que una sola
// factura cubra varios proyectos (cada uno con su parte proporcional).
async function sincronizarFacturaProyectos(facturaId, lineas) {
  await db.from("factura_proyectos").delete().eq("factura_id", facturaId).exec();
  const porProyecto = {};
  for (const l of lineas) {
    if (!l.proyecto_id) continue;
    const importe = Number(l.cantidad || 1) * Number(l.precio || 0);
    porProyecto[l.proyecto_id] = round2((porProyecto[l.proyecto_id] || 0) + importe);
  }
  const filas = Object.entries(porProyecto).map(([proyecto_id, importe]) => ({ factura_id: facturaId, proyecto_id, importe }));
  if (filas.length) await db.from("factura_proyectos").insert(filas).exec();
}

// Saca el secuencial de un número de documento: "PRE-16-2026" → 16,
// "01-2026" → 1. Devuelve null si no encaja con el formato.
export function secuencialDe(numero) {
  const m = String(numero || "").trim().match(/^(?:PRE-)?0*(\d+)-(\d{4})$/i);
  return m ? parseInt(m[1], 10) : null;
}

// El siguiente número es el MÁXIMO usado + 1, no "cuántos hay" + 1. Contar
// filas parecía funcionar hasta que se borraba un documento: entonces el
// siguiente repetía un número ya emitido, que en facturas es un problema
// fiscal serio.
async function siguienteSecuencial(tipo, year) {
  const { data } = await db.from("facturas").select("numero").eq("tipo", tipo)
    .gte("fecha", `${year}-01-01`).lte("fecha", `${year}-12-31`).exec();
  const usados = (data || []).map(f => secuencialDe(f.numero)).filter(n => n != null);
  return (usados.length ? Math.max(...usados) : 0) + 1;
}

export async function nextNumero() {
  const year = new Date().getFullYear();
  const n = await siguienteSecuencial("factura", year);
  return `${String(n).padStart(2, "0")}-${year}`;
}

// Numeración propia para presupuestos (serie "PRE-…"), totalmente
// independiente de la de facturas — igual que en Holded, aceptar un
// presupuesto no "gasta" ni interfiere con la numeración fiscal de facturas.
// El último presupuesto real de Josep (hecho antes de tener esta app) fue el
// 15, así que el primero generado aquí debe ser como mínimo el 16, aunque en
// la tabla todavía haya menos de 15 filas registradas.
const PRIMER_NUMERO_PRESUPUESTO = 16;
export async function nextNumeroPresupuesto() {
  const year = new Date().getFullYear();
  const n = Math.max(await siguienteSecuencial("presupuesto", year), PRIMER_NUMERO_PRESUPUESTO);
  return `PRE-${String(n).padStart(2, "0")}-${year}`;
}

async function renderEditor(container, { proyectoId, facturaId, tipoDefecto, volverA }) {
  const [{ data: clientes }, { data: proyectosDisponibles }, { data: servicios }, { data: condicionesGuardadas }] = await Promise.all([
    db.from("clientes").select("*").order("nombre").exec(),
    // precio_acordado hace falta para que "Añadir proyecto" rellene el importe.
    db.from("proyectos").select("id,nombre,precio_acordado").order("nombre").exec(),
    listarServicios({ soloActivos: true }),
    listarCondiciones({ soloActivas: true }),
  ]);
  let draft = { numero: "", tipo: tipoDefecto || "factura", fecha: todayIso(), fecha_vencimiento: "", cliente_id: clientes?.[0]?.id || "", proyecto_id: null, proyecto_nombre: "", lineas: [{ concepto: "", cantidad: 1, precio: 0, proyecto_id: "", descripcion: "", descuento_tipo: "porcentaje", descuento_valor: 0 }], iva_pct: 21, retencion_pct: 0, estado: "borrador", descuento_tipo: "porcentaje", descuento_valor: 0, condiciones: [] };
  let origenProyectoTexto = "";

  if (facturaId) {
    const [{ data }, { data: vinculos }] = await Promise.all([
      db.from("facturas").select("*").eq("id", facturaId).single().exec(),
      db.from("factura_proyectos").select("importe,proyecto_id,proyectos(nombre)").eq("factura_id", facturaId).exec(),
    ]);
    if (data) {
      // Las líneas GUARDADAS mandan siempre que existan. Antes se daba
      // prioridad a los vínculos con proyectos, y eso destruía el trabajo del
      // usuario: sincronizarFacturaProyectos agrupa por proyecto sumando
      // importes, así que un documento con tres conceptos del mismo proyecto
      // volvía a abrirse convertido en una sola línea con el nombre del
      // proyecto. Los vínculos solo se usan para RECONSTRUIR las líneas de una
      // factura que no tiene ninguna guardada — el caso de las creadas desde
      // Facturación mensual, que nacen vacías.
      const tieneLineasPropias = Array.isArray(data.lineas) && data.lineas.length > 0;
      const lineasDesdeVinculos = (!tieneLineasPropias && vinculos && vinculos.length)
        ? vinculos.map(v => ({ concepto: v.proyectos?.nombre || "Proyecto", cantidad: 1, precio: Number(v.importe || 0), proyecto_id: v.proyecto_id, descripcion: "" }))
        : null;
      const lineas = lineasDesdeVinculos
        || (tieneLineasPropias
              ? data.lineas.map(l => ({ proyecto_id: "", descripcion: "", descuento_tipo: "porcentaje", descuento_valor: 0, ...l }))
              : [{ concepto: "", cantidad: 1, precio: 0, proyecto_id: "", descripcion: "", descuento_tipo: "porcentaje", descuento_valor: 0 }]);
      draft = { ...data, lineas };
      if (lineasDesdeVinculos && lineasDesdeVinculos.length > 1) {
        origenProyectoTexto = `Esta factura agrupa ${lineasDesdeVinculos.length} proyectos, cada uno en su propia línea — revisa los importes antes de emitir.`;
      }
    }
  } else if (proyectoId) {
    const { data: proyecto } = await db.from("proyectos").select("*").eq("id", proyectoId).single().exec();
    if (proyecto) {
      draft.proyecto_id = proyecto.id;
      draft.cliente_id = proyecto.cliente_id;
      draft.lineas = [{ concepto: proyecto.nombre, cantidad: 1, precio: Number(proyecto.precio_acordado || 0), proyecto_id: proyecto.id, descripcion: "" }];
      origenProyectoTexto = `Generado automáticamente desde el proyecto "${proyecto.nombre}" — revisa los datos antes de enviar.`;
    }
    draft.numero = draft.tipo === "presupuesto" ? await nextNumeroPresupuesto() : await nextNumero();
  } else {
    draft.numero = draft.tipo === "presupuesto" ? await nextNumeroPresupuesto() : await nextNumero();
  }

  const esNuevo = !facturaId;
  const estadosDoc = draft.tipo === "presupuesto" ? ESTADOS_PRESUPUESTO : ESTADOS_FACTURA;
  const volver = volverA || (draft.tipo === "presupuesto" ? "#/presupuestos" : "#/facturacion");
  const puedeConvertir = !esNuevo && draft.tipo === "presupuesto";

    container.innerHTML = `
    <div class="editor-top">
      <a class="back-link" href="${volver}">← Volver a ${draft.tipo === "presupuesto" ? "Presupuestos" : "Facturas"}</a>
      <span class="doc-badge ${draft.tipo === "presupuesto" ? "es-presupuesto" : "es-factura"}">${draft.tipo === "presupuesto" ? "Presupuesto" : "Factura"}</span>
    </div>
    ${origenProyectoTexto ? `<div class="ai-banner">✨ ${escapeHtml(origenProyectoTexto)}</div>` : ""}

    <div class="wizard-head card">
      <div class="wizard-head-top">
        <div>
          <p class="wizard-kicker">${esNuevo ? "Proceso guiado" : "Edición"}</p>
          <h2 class="wizard-titulo">${esNuevo ? (draft.tipo === "presupuesto" ? "Crear presupuesto" : "Crear factura") : `${draft.tipo === "presupuesto" ? "Presupuesto" : "Factura"} ${escapeHtml(draft.numero)}`}</h2>
        </div>
        <p class="wizard-ayuda">${esNuevo
          ? "Completa los datos paso a paso. El total se actualiza en tiempo real a la derecha."
          : "Salta a la sección que quieras: no hace falta pasar por todas."}</p>
      </div>
      <div class="wizard-progreso"><span id="wz-barra"></span></div>
      <div class="wizard-pasos" id="wz-pasos"></div>
    </div>

    <div class="editor-layout">
      <div class="editor-main">

        <section class="paso" data-paso="cliente">
        <div class="card">
          <div class="card-head"><h3>Cliente</h3></div>
          <div class="row">
            <div class="field" style="flex:2;"><label>Cliente</label>
              <select id="f-cliente">${(clientes || []).map(c => `<option value="${c.id}" ${c.id === draft.cliente_id ? "selected" : ""}>${escapeHtml(c.nombre)}</option>`).join("")}</select>
            </div>
          </div>
          ${draft.tipo === "presupuesto" ? `
          <div class="row">
            <div class="field" style="flex:1;">
              <label>Proyecto</label>
              <input id="f-proyecto-nombre" placeholder="Ej. Videoclip — Grupo X" value="${escapeAttr(draft.proyecto_nombre || "")}">
              <p class="hint" style="margin:6px 0 0;">Es el nombre que sale en el PDF. Texto libre: el proyecto todavía no existe, nace si aceptan el presupuesto.</p>
            </div>
          </div>` : ""}
        </div>
        </section>

        <section class="paso" data-paso="datos">
        <div class="card">
          <div class="card-head"><h3>${draft.tipo === "presupuesto" ? "Datos del presupuesto" : "Datos de la factura"}</h3></div>
          <div class="row">
            <div class="field"><label>Nº</label><input id="f-numero" value="${escapeAttr(draft.numero)}"></div>
            <div class="field"><label>Estado</label>
              <select id="f-estado">${Object.entries(estadosDoc).map(([k, v]) => `<option value="${k}" ${k === draft.estado ? "selected" : ""}>${v.label}</option>`).join("")}</select>
            </div>
          </div>
          <div class="row">
            <div class="field"><label>Fecha</label><input type="date" id="f-fecha" value="${draft.fecha}"></div>
            <div class="field"><label>Vencimiento</label><input type="date" id="f-vencimiento" value="${draft.fecha_vencimiento || ""}"></div>
          </div>
        </div>
        </section>

        <section class="paso" data-paso="lineas">
        <div class="card">
          <div class="card-head">
            <h3>Líneas ${draft.tipo === "presupuesto" ? "del presupuesto" : "de la factura"}</h3>
            <div class="lineas-toolbar">
              <div class="menu" id="menu-servicios">
                <button class="btn btn-ghost" type="button" data-menu-btn>Añadir servicio <span class="caret">▾</span></button>
                <div class="menu-panel" data-menu-panel></div>
              </div>
              ${draft.tipo === "presupuesto" ? "" : `
              <div class="menu" id="menu-proyectos">
                <button class="btn btn-ghost" type="button" data-menu-btn>Añadir proyecto <span class="caret">▾</span></button>
                <div class="menu-panel" data-menu-panel></div>
              </div>`}
              <button class="btn btn-primary" id="btn-add-linea" type="button">+ Línea manual</button>
            </div>
          </div>

          <div id="form-servicio" class="form-inline hidden">
            <p class="muted">Guarda esta tarifa para no volver a teclearla. Queda disponible en todos tus dispositivos.</p>
            <div class="row">
              <div class="field" style="flex:2;"><label>Nombre del servicio</label><input id="ns-nombre" placeholder="Ej. Grabación de concierto"></div>
              <div class="field"><label>Precio (€, sin IVA)</label><input id="ns-precio" type="number" step="0.01" placeholder="0.00"></div>
              <div class="field"><label>Unidad</label><input id="ns-unidad" placeholder="jornada, hora…"></div>
            </div>
            <div class="field"><label>Descripción (opcional, se copia a la línea)</label><textarea id="ns-descripcion" rows="2" placeholder="Incluye media jornada de grabación más el bloqueo operativo de desplazamiento."></textarea></div>
            <div class="form-inline-acciones">
              <button class="btn btn-primary" id="btn-crear-servicio" type="button">Guardar tarifa y añadirla</button>
              <button class="btn btn-ghost" id="btn-cancelar-servicio" type="button">Cancelar</button>
            </div>
          </div>

          <div id="nuevo-proyecto-form" class="form-inline hidden">
            <p class="muted">Créalo ahora mismo — útil cuando el documento es para un trabajo que todavía no existe en Proyectos. Al guardar quedará vinculado a esta línea.</p>
            <div class="row">
              <div class="field" style="flex:2;"><label>Nombre del proyecto</label><input id="np-nombre" placeholder="Ej. Boda Marta y Juan"></div>
              <div class="field"><label>Precio acordado (€, sin IVA)</label><input id="np-precio" type="number" step="0.01" placeholder="0.00"></div>
            </div>
            <div class="row">
              <div class="field"><label>Categoría de servicio</label>
                <select id="np-categoria">${Object.entries(CATEGORIAS_SERVICIO).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}</select>
              </div>
              <div class="field"><label>Fecha de inicio</label><input type="date" id="np-fecha" value="${todayIso()}"></div>
            </div>
            <div class="form-inline-acciones">
              <button class="btn btn-primary" id="btn-crear-proyecto" type="button">Crear y usar en esta línea</button>
              <button class="btn btn-ghost" id="btn-cancelar-proyecto" type="button">Cancelar</button>
            </div>
          </div>

          <div id="lineas-wrap"></div>
        </div>
        </section>

        ${draft.tipo === "presupuesto" ? `
        <section class="paso" data-paso="condiciones">
        <div class="card">
          <div class="card-head">
            <h3>Condiciones del presupuesto</h3>
            <div class="menu" id="menu-condiciones">
              <button class="btn btn-ghost" type="button" data-menu-btn>Añadir condición <span class="caret">▾</span></button>
              <div class="menu-panel" data-menu-panel></div>
            </div>
          </div>
          <p class="muted" style="margin:-4px 0 10px;">Las generales vienen ya puestas. Añade el pack de rodaje o de postproducción según lo que cubra el trabajo. Todas se pueden editar o quitar: el PDF imprime exactamente esta lista, nada más.</p>
          <div id="form-condicion" class="form-inline hidden">
            <div class="field"><label>Condición nueva</label><textarea id="cond-nueva" rows="2" placeholder="Ej. El uso de láseres durante el evento impediría por completo la grabación."></textarea></div>
            <div class="form-inline-acciones">
              <button class="btn btn-primary" id="btn-add-condicion" type="button">Añadir y guardar en la biblioteca</button>
              <button class="btn btn-ghost" id="btn-cancelar-condicion" type="button">Cancelar</button>
            </div>
          </div>
          <div id="condiciones-elegidas"></div>
        </div>
        </section>` : ""}

        <section class="paso" data-paso="confirmacion">
        <div class="card">
          <div class="card-head"><h3>Impuestos y descuento</h3></div>
          <div class="row">
            <div class="field"><label>IVA %</label><input type="number" id="f-iva" value="${draft.iva_pct}"></div>
            <div class="field"><label>Retención IRPF %</label><input type="number" id="f-retencion" value="${draft.retencion_pct}"></div>
            <div class="field">
              <label>Descuento global</label>
              <div class="dto-cell">
                <input type="number" step="0.01" min="0" id="f-descuento-valor" value="${Number(draft.descuento_valor || 0)}">
                <select id="f-descuento-tipo">
                  <option value="porcentaje" ${(draft.descuento_tipo||"porcentaje")==="porcentaje"?"selected":""}>%</option>
                  <option value="importe" ${draft.descuento_tipo==="importe"?"selected":""}>€</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <div class="card" id="repaso-final">
          <div class="card-head"><h3>Todo listo</h3></div>
          <div id="repaso-contenido"></div>
        </div>
        </section>
      </div>

      <aside class="editor-aside">
        <div class="card resumen-card">
          <p class="resumen-label">Total ${draft.tipo === "presupuesto" ? "del presupuesto" : "de la factura"}</p>
          <p class="resumen-total" id="res-total">—</p>
          <div class="resumen-desglose" id="res-desglose"></div>
          <div id="aviso-cliente"></div>
          <div class="resumen-acciones">
            <button class="btn btn-primary" id="btn-guardar">Guardar</button>
            <button class="btn btn-dark" id="btn-pdf">Descargar PDF</button>
            ${puedeConvertir ? `<button class="btn btn-ghost" id="btn-convertir" type="button" style="border-color:var(--green-fg); color:var(--green-fg);">Convertir en factura →</button>` : ""}
            ${puedeConvertir ? `<button class="btn btn-ghost" id="btn-convertir-proyecto" type="button" style="border-color:var(--blue); color:var(--blue);">${draft.proyecto_id ? "Ver el proyecto →" : "Convertir en proyecto →"}</button>` : ""}
            ${(!esNuevo && draft.tipo === "presupuesto") ? `<button class="btn btn-ghost" id="btn-borrar-doc" type="button" style="border-color:var(--red-fg,#B4453A); color:var(--red-fg,#B4453A);">Eliminar</button>` : ""}
          </div>
        </div>
      </aside>
    </div>

    <div class="wizard-footer" id="wz-footer">
      <span class="wizard-footer-paso" id="wz-etiqueta"></span>
      <div class="wizard-footer-acciones">
        <button class="btn btn-ghost" id="wz-anterior" type="button">← Anterior</button>
        <a class="btn btn-ghost" href="${volver}">Cancelar</a>
        <button class="btn btn-primary" id="wz-siguiente" type="button">Continuar →</button>
      </div>
    </div>`;

  // --- Menús desplegables (servicios, proyectos, condiciones) ---
  // Uno solo abierto a la vez, y se cierran al pulsar fuera o con Escape.
  // La tarjeta que contiene el menú abierto se eleva mientras dura. Sin esto el
  // panel salía POR DEBAJO de las tarjetas siguientes: la animación de entrada
  // (animarVista) deja transform/opacity en cada tarjeta, y eso crea un
  // contexto de apilamiento propio contra el que no puede competir el z-index
  // del panel.
  function cerrarMenus() {
    container.querySelectorAll(".menu.abierto").forEach(m => m.classList.remove("abierto"));
    container.querySelectorAll(".card.con-menu-abierto").forEach(c => c.classList.remove("con-menu-abierto"));
  }
  container.querySelectorAll(".menu").forEach(menu => {
    menu.querySelector("[data-menu-btn]").addEventListener("click", (e) => {
      e.stopPropagation();
      const abierto = menu.classList.contains("abierto");
      cerrarMenus();
      if (!abierto) {
        menu.classList.add("abierto");
        menu.closest(".card")?.classList.add("con-menu-abierto");
      }
    });
  });
  document.addEventListener("click", cerrarMenus);
  document.addEventListener("keydown", e => { if (e.key === "Escape") cerrarMenus(); });

  // --- Proceso guiado por pasos ---
  // Todas las secciones siguen en el DOM y solo se ocultan: actualizar() lee
  // #f-iva, #f-cliente y compañía en cualquier momento, así que desmontarlas
  // rompería el cálculo del total en cuanto cambiaras de paso.
  const PASOS = [
    { id: "cliente", label: "Cliente" },
    { id: "datos", label: draft.tipo === "presupuesto" ? "Datos del presupuesto" : "Datos de la factura" },
    { id: "lineas", label: "Líneas" },
    ...(draft.tipo === "presupuesto" ? [{ id: "condiciones", label: "Condiciones" }] : []),
    { id: "confirmacion", label: "Confirmación" },
  ];
  let pasoActual = 0;
  const $wzPasos = container.querySelector("#wz-pasos");
  const $wzBarra = container.querySelector("#wz-barra");
  const $wzAnterior = container.querySelector("#wz-anterior");
  const $wzSiguiente = container.querySelector("#wz-siguiente");
  const $wzEtiqueta = container.querySelector("#wz-etiqueta");

  // Los botones se pintan UNA vez y luego solo se les cambian las clases. Si se
  // rehiciera el HTML en cada paso, el navegador tiraría los nodos viejos y las
  // transiciones de color no llegarían a ejecutarse: el cambio se vería "a
  // corte" en vez de progresivo.
  function pintarPasos() {
    $wzPasos.innerHTML = PASOS.map((p, i) => `
      <button class="wz-paso" data-i="${i}" type="button">
        <span class="wz-paso-num"><span class="wz-num-cifra">${i + 1}</span><span class="wz-num-check">✓</span></span>
        <span class="wz-paso-txt"><strong>${p.label}</strong>${esNuevo ? `<small></small>` : ""}</span>
      </button>`).join("");
    $wzPasos.querySelectorAll("[data-i]").forEach(b => {
      b.addEventListener("click", () => irAPaso(Number(b.dataset.i)));
    });
    actualizarPasos();
  }

  function actualizarPasos() {
    $wzPasos.querySelectorAll("[data-i]").forEach(b => {
      const i = Number(b.dataset.i);
      const hecho = esNuevo && i < pasoActual;
      b.classList.toggle("activo", i === pasoActual);
      b.classList.toggle("hecho", hecho);
      const $small = b.querySelector("small");
      if ($small) $small.textContent = i === pasoActual ? "En curso" : hecho ? "Completado" : "Pendiente";
    });
  }

  // Solo se valida al AVANZAR en un documento nuevo. Editando uno ya hecho no
  // tiene sentido bloquear: puedes querer entrar a cambiar solo la fecha.
  function puedeAvanzar() {
    const id = PASOS[pasoActual].id;
    if (id === "lineas" && !draft.lineas.some(l => String(l.concepto || "").trim())) {
      toastError("Añade al menos un concepto antes de continuar.");
      return false;
    }
    return true;
  }

  function irAPaso(i) {
    if (i === pasoActual) return;
    if (esNuevo && i > pasoActual && !puedeAvanzar()) return;
    pasoActual = Math.max(0, Math.min(PASOS.length - 1, i));
    mostrarPaso();
  }

  function mostrarPaso() {
    const idActual = PASOS[pasoActual].id;
    container.querySelectorAll(".paso").forEach(s => { s.hidden = s.dataset.paso !== idActual; });
    actualizarPasos();
    $wzBarra.style.width = `${((pasoActual + 1) / PASOS.length) * 100}%`;
    $wzEtiqueta.textContent = `Paso ${pasoActual + 1} de ${PASOS.length} · ${PASOS[pasoActual].label}`;
    $wzAnterior.hidden = pasoActual === 0;
    const ultimo = pasoActual === PASOS.length - 1;
    $wzSiguiente.textContent = ultimo ? "Guardar y terminar" : "Continuar →";
    if (ultimo) pintarRepaso();
    container.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  function pintarRepaso() {
    const calc = actualizar();
    const cliente = (clientes || []).find(c => c.id === container.querySelector("#f-cliente").value);
    const faltan = camposClienteQueFaltan();
    const conConcepto = draft.lineas.filter(l => String(l.concepto || "").trim()).length;
    container.querySelector("#repaso-contenido").innerHTML = `
      <div class="repaso-grid">
        <div><span>Cliente</span><strong>${escapeHtml(cliente?.nombre || "—")}</strong></div>
        <div><span>Número</span><strong>${escapeHtml(container.querySelector("#f-numero").value)}</strong></div>
        <div><span>Fecha</span><strong>${dateEs(container.querySelector("#f-fecha").value)}</strong></div>
        ${draft.tipo === "presupuesto" ? `<div><span>Proyecto</span><strong>${escapeHtml(container.querySelector("#f-proyecto-nombre")?.value || "—")}</strong></div>` : ""}
        <div><span>Conceptos</span><strong>${conConcepto}</strong></div>
        ${draft.tipo === "presupuesto" ? `<div><span>Condiciones</span><strong>${draft.condiciones.length}</strong></div>` : ""}
        <div><span>Total</span><strong>${eur(Number(calc?.total || 0))}</strong></div>
      </div>
      ${faltan.length ? `<div class="ai-banner" style="margin-top:14px;">Al cliente le falta ${faltan.join(", ")}. Puedes guardar igual, pero el PDF saldrá con la marca de borrador.</div>` : ""}`;
  }

  $wzAnterior.addEventListener("click", () => irAPaso(pasoActual - 1));
  $wzSiguiente.addEventListener("click", () => {
    if (pasoActual === PASOS.length - 1) { container.querySelector("#btn-guardar").click(); return; }
    if (!puedeAvanzar()) return;
    irAPaso(pasoActual + 1);
  });

  const $lineasWrap = container.querySelector("#lineas-wrap");
  const esPresupuestoDraft = draft.tipo === "presupuesto";

  function lineaVacia() {
    return { concepto: "", cantidad: 1, precio: 0, proyecto_id: "", descripcion: "", descuento_tipo: "porcentaje", descuento_valor: 0 };
  }

  // Reordenar: mover un elemento de una posición a otra dentro de un array.
  // Se usa igual para las líneas y para las condiciones.
  function moverEn(lista, desde, hasta) {
    if (hasta < 0 || hasta >= lista.length || desde === hasta) return false;
    const [item] = lista.splice(desde, 1);
    lista.splice(hasta, 0, item);
    return true;
  }

  function moverLinea(desde, hasta) {
    if (!moverEn(draft.lineas, desde, hasta)) return;
    pintarLineas();
    actualizar();
  }

  // Arrastrar y soltar sobre filas. El tirador activa `draggable` en la fila
  // (así la imagen que se arrastra es la fila entera, no solo el icono) y lo
  // desactiva al soltar, para no interferir con la selección de texto de los
  // inputs.
  function engancharArrastre(contenedor, selectorFila, selectorTirador, alSoltar) {
    let origen = null;
    contenedor.querySelectorAll(selectorFila).forEach(fila => {
      const tirador = fila.querySelector(selectorTirador);
      if (!tirador) return;
      tirador.addEventListener("mousedown", () => { fila.draggable = true; });
      fila.addEventListener("dragstart", (e) => {
        origen = fila;
        fila.classList.add("arrastrando");
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", ""); } catch {}
      });
      fila.addEventListener("dragend", () => {
        fila.draggable = false;
        fila.classList.remove("arrastrando");
        contenedor.querySelectorAll(".soltar-aqui").forEach(x => x.classList.remove("soltar-aqui"));
        origen = null;
      });
      fila.addEventListener("dragover", (e) => {
        if (!origen || origen === fila) return;
        e.preventDefault();
        fila.classList.add("soltar-aqui");
      });
      fila.addEventListener("dragleave", () => fila.classList.remove("soltar-aqui"));
      fila.addEventListener("drop", (e) => {
        if (!origen || origen === fila) return;
        e.preventDefault();
        fila.classList.remove("soltar-aqui");
        alSoltar(Number(origen.dataset.idx ?? origen.dataset.i), Number(fila.dataset.idx ?? fila.dataset.i));
      });
    });
  }

  function pintarLineas() {
    if (!draft.lineas.length) {
      $lineasWrap.innerHTML = `<div class="empty-state" style="padding:28px 10px;">Todavía no hay líneas. Añade un servicio guardado, un proyecto o una línea manual.</div>`;
      return;
    }
    $lineasWrap.innerHTML = `
      <div class="tabla-scroll">
      <table class="tabla-lineas">
        <thead>
          <tr>
            <th class="col-mover"></th>
            <th>Concepto${esPresupuestoDraft ? " y descripción" : ""}</th>
            <th class="col-num col-cant">Cant.</th>
            <th class="col-num col-precio">Precio</th>
            <th class="col-num col-dto">Dto.</th>
            ${esPresupuestoDraft ? "" : `<th class="col-proy">Proyecto</th>`}
            <th class="col-num col-total">Total</th>
            <th class="col-acc"></th>
          </tr>
        </thead>
        <tbody>
        ${draft.lineas.map((l, i) => `
          <tr data-idx="${i}">
            <td class="col-mover">
              <span class="mover-tirador" title="Arrastra para reordenar">⠿</span>
              <span class="mover-flechas">
                <button class="icon-btn btn-subir" type="button" title="Subir" ${i === 0 ? "disabled" : ""}>↑</button>
                <button class="icon-btn btn-bajar" type="button" title="Bajar" ${i === draft.lineas.length - 1 ? "disabled" : ""}>↓</button>
              </span>
            </td>
            <td data-label="Concepto">
              <input class="linea-concepto" placeholder="Concepto" value="${escapeAttr(l.concepto)}">
              ${esPresupuestoDraft ? `
              <div class="linea-desc-wrap">
                <textarea class="linea-descripcion" rows="2" placeholder="Descripción (opcional) — sale bajo el concepto en el PDF">${escapeHtml(l.descripcion || "")}</textarea>
                <button class="btn btn-ghost btn-mejorar-ia" type="button" title="${tieneClaveGemini() ? "Mejorar esta descripción con IA" : "Añade tu clave de Gemini en Configuración para usar esto"}">✨ IA</button>
              </div>` : ""}
            </td>
            <td data-label="Cant." class="col-num col-cant"><input class="linea-cantidad" type="number" step="1" value="${l.cantidad}"></td>
            <td data-label="Precio" class="col-num col-precio"><input class="linea-precio" type="number" step="0.01" value="${l.precio}"></td>
            <td data-label="Dto." class="col-num col-dto">
              <div class="dto-cell">
                <input class="linea-desc-valor" type="number" step="0.01" min="0" value="${Number(l.descuento_valor || 0)}">
                <select class="linea-desc-tipo">
                  <option value="porcentaje" ${(l.descuento_tipo||"porcentaje")==="porcentaje"?"selected":""}>%</option>
                  <option value="importe" ${l.descuento_tipo==="importe"?"selected":""}>€</option>
                </select>
              </div>
            </td>
            ${esPresupuestoDraft ? "" : `
            <td data-label="Proyecto" class="col-proy">
              <select class="linea-proyecto">
                <option value="">(sin proyecto)</option>
                ${(proyectosDisponibles || []).map(p => `<option value="${p.id}" ${p.id === l.proyecto_id ? "selected" : ""}>${escapeHtml(p.nombre)}</option>`).join("")}
              </select>
            </td>`}
            <td data-label="Total" class="col-num col-total"><span class="linea-total"></span></td>
            <td class="col-acc"><button class="icon-btn btn-quitar-linea" type="button" title="Quitar línea">✕</button></td>
          </tr>`).join("")}
        </tbody>
      </table>
      </div>`;

    $lineasWrap.querySelectorAll("tr[data-idx]").forEach(row => {
      const idx = Number(row.dataset.idx);
      row.querySelector(".linea-concepto").addEventListener("input", e => { draft.lineas[idx].concepto = e.target.value; actualizar(); });
      row.querySelector(".linea-cantidad").addEventListener("input", e => { draft.lineas[idx].cantidad = Number(e.target.value || 0); actualizar(); });
      row.querySelector(".linea-precio").addEventListener("input", e => { draft.lineas[idx].precio = Number(e.target.value || 0); actualizar(); });
      // En presupuestos ya no hay proyecto por línea: el documento entero tiene
      // uno solo, en el campo "Proyecto" de arriba.
      row.querySelector(".linea-proyecto")?.addEventListener("change", e => { draft.lineas[idx].proyecto_id = e.target.value; });
      row.querySelector(".btn-subir").addEventListener("click", () => moverLinea(idx, idx - 1));
      row.querySelector(".btn-bajar").addEventListener("click", () => moverLinea(idx, idx + 1));
      row.querySelector(".linea-desc-valor").addEventListener("input", e => { draft.lineas[idx].descuento_valor = Number(e.target.value || 0); actualizar(); });
      row.querySelector(".linea-desc-tipo").addEventListener("change", e => { draft.lineas[idx].descuento_tipo = e.target.value; actualizar(); });
      row.querySelector(".btn-quitar-linea").addEventListener("click", () => { draft.lineas.splice(idx, 1); pintarLineas(); actualizar(); });
      const $desc = row.querySelector(".linea-descripcion");
      if ($desc) $desc.addEventListener("input", e => { draft.lineas[idx].descripcion = e.target.value; });
      const $btnIA = row.querySelector(".btn-mejorar-ia");
      if ($btnIA) $btnIA.addEventListener("click", async () => {
        if (!tieneClaveGemini()) { toastError("Añade tu clave gratuita de Gemini en Configuración → IA para presupuestos antes de usar esto."); return; }
        const notaActual = $desc.value.trim();
        if (!notaActual) { toastError("Escribe primero una nota breve (p. ej. 'grabación 4h pista padel') y luego pulsa IA."); return; }
        $btnIA.disabled = true;
        const textoOriginal = $btnIA.textContent;
        $btnIA.textContent = "…";
        try {
          const mejorada = await mejorarDescripcionConIA(draft.lineas[idx].concepto, notaActual);
          draft.lineas[idx].descripcion = mejorada;
          $desc.value = mejorada;
        } catch (e) {
          toastError("No se ha podido mejorar la descripción: " + e.message);
        } finally {
          $btnIA.disabled = false;
          $btnIA.textContent = textoOriginal;
        }
      });
    });

    engancharArrastre($lineasWrap, "tr[data-idx]", ".mover-tirador", moverLinea);
  }

  function actualizar() {
    const ivaPct = Number(container.querySelector("#f-iva").value || 0);
    const retencionPct = Number(container.querySelector("#f-retencion").value || 0);
    draft.descuento_tipo = container.querySelector("#f-descuento-tipo")?.value || "porcentaje";
    draft.descuento_valor = Number(container.querySelector("#f-descuento-valor")?.value || 0);
    const calc = calcularFactura({
      lineas: draft.lineas, ivaPct, retencionPct,
      descuentoTipo: draft.descuento_tipo, descuentoValor: draft.descuento_valor,
    });

    // Total de cada línea, con el precio original tachado si lleva descuento —
    // el mismo lenguaje visual que el PDF, para que lo que ves en pantalla y lo
    // que sale impreso se lean igual.
    $lineasWrap.querySelectorAll("tr[data-idx]").forEach(row => {
      const l = draft.lineas[Number(row.dataset.idx)];
      if (!l) return;
      const d = desglosarLinea(l);
      row.querySelector(".linea-total").innerHTML = d.descuento > 0
        ? `<span class="importe-tachado">${eur(d.bruto)}</span><br><strong>${eur(d.neto)}</strong>`
        : `<strong>${eur(d.neto)}</strong>`;
    });

    container.querySelector("#res-total").textContent = eur(calc.total);
    const fila = (etq, val, clase = "") => `<div class="resumen-fila ${clase}"><span>${etq}</span><span>${val}</span></div>`;
    container.querySelector("#res-desglose").innerHTML = [
      (calc.descuento_lineas > 0 || calc.descuento_importe > 0)
        ? fila("Suma de líneas", eur(round2(calc.subtotal + calc.descuento_lineas))) : "",
      calc.descuento_lineas > 0 ? fila("Dto. en líneas", `−${eur(calc.descuento_lineas)}`, "es-descuento") : "",
      calc.descuento_importe > 0 ? fila("Dto. global", `−${eur(calc.descuento_importe)}`, "es-descuento") : "",
      fila("Base imponible", eur(calc.base_imponible)),
      fila(`IVA ${ivaPct}%`, eur(calc.iva_importe)),
      retencionPct > 0 ? fila(`Retención IRPF ${retencionPct}%`, `−${eur(calc.retencion_importe)}`, "es-descuento") : "",
    ].join("");

    return calc;
  }

  // --- Desplegable de servicios (tarifas guardadas) ---
  function pintarMenuServicios() {
    const $panel = container.querySelector("#menu-servicios [data-menu-panel]");
    const activos = (servicios || []).filter(s => s.activo !== false);
    $panel.innerHTML = `
      ${activos.length
        ? activos.map(s => `<button class="menu-item es-servicio" type="button" data-servicio="${s.id}">
             <span class="servicio-info">
               <span class="servicio-nombre">${escapeHtml(s.nombre || "")}</span>
               ${s.unidad ? `<span class="servicio-unidad">${escapeHtml(s.unidad)}</span>` : ""}
             </span>
             <span class="menu-item-precio">${eur(Number(s.precio || 0))}</span>
           </button>`).join("")
        : `<p class="menu-vacio">Todavía no tienes tarifas guardadas.</p>`}
      <div class="menu-sep"></div>
      <button class="menu-item es-accion" type="button" id="mi-nuevo-servicio">＋ Crear una tarifa nueva…</button>`;
    $panel.querySelectorAll("[data-servicio]").forEach(btn => {
      btn.addEventListener("click", () => {
        const s = servicios.find(x => x.id === btn.dataset.servicio);
        if (!s) return;
        draft.lineas.push(servicioALinea(s));
        cerrarMenus();
        pintarLineas();
        actualizar();
      });
    });
    $panel.querySelector("#mi-nuevo-servicio").addEventListener("click", () => {
      cerrarMenus();
      container.querySelector("#nuevo-proyecto-form").classList.add("hidden");
      container.querySelector("#form-servicio").classList.remove("hidden");
      container.querySelector("#ns-nombre").focus();
    });
  }

  // --- Desplegable de proyectos ---
  function pintarMenuProyectos() {
    // En presupuestos este menú no se pinta: el proyecto es uno solo y va en
    // su propio campo, no por línea.
    const $panel = container.querySelector("#menu-proyectos [data-menu-panel]");
    if (!$panel) return;
    const yaUsados = new Set(draft.lineas.map(l => l.proyecto_id).filter(Boolean));
    const disponibles = (proyectosDisponibles || []).filter(p => !yaUsados.has(p.id));
    $panel.innerHTML = `
      ${disponibles.length
        ? disponibles.map(p => `<button class="menu-item" type="button" data-proyecto="${p.id}">
             <span class="menu-item-nombre">${escapeHtml(p.nombre)}</span>
             <span class="menu-item-precio">${eur(Number(p.precio_acordado || 0))}</span>
           </button>`).join("")
        : `<p class="menu-vacio">${(proyectosDisponibles || []).length ? "Todos tus proyectos ya están en este documento." : "Todavía no tienes proyectos."}</p>`}
      <div class="menu-sep"></div>
      <button class="menu-item es-accion" type="button" id="mi-nuevo-proyecto">＋ Crear un proyecto nuevo…</button>`;
    $panel.querySelectorAll("[data-proyecto]").forEach(btn => {
      btn.addEventListener("click", () => {
        const p = (proyectosDisponibles || []).find(x => x.id === btn.dataset.proyecto);
        if (!p) return;
        draft.lineas.push({ ...lineaVacia(), concepto: p.nombre, precio: Number(p.precio_acordado || 0), proyecto_id: p.id });
        cerrarMenus();
        pintarLineas();
        actualizar();
      });
    });
    $panel.querySelector("#mi-nuevo-proyecto").addEventListener("click", () => {
      cerrarMenus();
      container.querySelector("#form-servicio").classList.add("hidden");
      container.querySelector("#nuevo-proyecto-form").classList.remove("hidden");
      container.querySelector("#np-nombre").focus();
    });
  }

  pintarMenuServicios();
  pintarMenuProyectos();

  // --- Crear tarifa desde el propio editor ---
  container.querySelector("#btn-cancelar-servicio").addEventListener("click", () => {
    container.querySelector("#form-servicio").classList.add("hidden");
  });
  container.querySelector("#btn-crear-servicio").addEventListener("click", async () => {
    const nombre = container.querySelector("#ns-nombre").value.trim();
    if (!nombre) { toastError("Ponle un nombre a la tarifa."); return; }
    const payload = {
      nombre,
      precio: Number(container.querySelector("#ns-precio").value || 0),
      unidad: container.querySelector("#ns-unidad").value,
      descripcion: container.querySelector("#ns-descripcion").value,
      orden: (servicios || []).length,
    };
    const { data, error } = await crearServicio(payload);
    if (error) { toastError("Error guardando la tarifa: " + error); return; }
    const nuevo = Array.isArray(data) ? data[0] : data;
    servicios.push(nuevo);
    draft.lineas.push(servicioALinea(nuevo));
    ["#ns-nombre", "#ns-precio", "#ns-unidad", "#ns-descripcion"].forEach(sel => { container.querySelector(sel).value = ""; });
    container.querySelector("#form-servicio").classList.add("hidden");
    pintarMenuServicios();
    pintarLineas();
    actualizar();
    toastOk(`Tarifa "${nombre}" guardada y añadida.`);
  });

    // --- Condiciones del presupuesto ---
  // Ya no hay condiciones "fijas" imprimibles a la fuerza: las marcadas por
  // defecto se precargan aquí y desde este momento son del documento, editables
  // y quitables una a una. Lo que se guarda son los TEXTOS, no referencias, así
  // que retocar una para un presupuesto concreto no cambia la plantilla, y
  // borrar la plantilla no vacía los presupuestos antiguos.
  draft.condiciones = Array.isArray(draft.condiciones) ? draft.condiciones : [];
  if (esPresupuestoDraft && draft.condiciones.length === 0) {
    // Los presupuestos guardados antes de este cambio no tienen condiciones
    // propias porque el PDF se las añadía al imprimir. Se precargan igual que en
    // uno nuevo, de modo que reexportarlos da el mismo documento que enviaste.
    draft.condiciones = textosPorDefecto(condicionesGuardadas);
  }

  function moverCondicion(desde, hasta) {
    if (!moverEn(draft.condiciones, desde, hasta)) return;
    pintarCondiciones();
  }

  function pintarCondiciones() {
    const $elegidas = container.querySelector("#condiciones-elegidas");
    if (!$elegidas) return;
    $elegidas.innerHTML = draft.condiciones.length
      ? draft.condiciones.map((c, i) => `
        <div class="cond-row" data-i="${i}">
          <span class="cond-mover">
            <span class="mover-tirador" title="Arrastra para reordenar">⠿</span>
            <button class="icon-btn btn-subir-cond" type="button" title="Subir" ${i === 0 ? "disabled" : ""}>↑</button>
            <button class="icon-btn btn-bajar-cond" type="button" title="Bajar" ${i === draft.condiciones.length - 1 ? "disabled" : ""}>↓</button>
          </span>
          <textarea class="cond-texto" rows="2">${escapeHtml(c)}</textarea>
          <button class="icon-btn btn-quitar-cond" type="button" title="Quitar de este presupuesto">✕</button>
        </div>`).join("")
      : `<p class="muted" style="margin:0;">Este presupuesto sale sin condiciones. Añade las que apliquen.</p>`;
    $elegidas.querySelectorAll(".cond-row").forEach(row => {
      const i = Number(row.dataset.i);
      // Edición libre: es lo que permite cambiar "episodio" por "videoclip" en
      // un presupuesto sin tocar el resto.
      row.querySelector(".cond-texto").addEventListener("input", e => { draft.condiciones[i] = e.target.value; });
      row.querySelector(".btn-quitar-cond").addEventListener("click", () => {
        draft.condiciones.splice(i, 1);
        pintarCondiciones();
      });
      row.querySelector(".btn-subir-cond").addEventListener("click", () => moverCondicion(i, i - 1));
      row.querySelector(".btn-bajar-cond").addEventListener("click", () => moverCondicion(i, i + 1));
    });
    engancharArrastre($elegidas, ".cond-row", ".mover-tirador", moverCondicion);
    pintarMenuCondiciones();
  }

  function pintarMenuCondiciones() {
    const $panel = container.querySelector("#menu-condiciones [data-menu-panel]");
    if (!$panel) return;
    const disponibles = (condicionesGuardadas || []).filter(c => !draft.condiciones.includes(c.texto));
    // Packs: añaden de golpe las condiciones FIJAS de rodaje o de postproducción.
    // Se ofrecen solo si queda alguna por añadir, para no dejar un botón muerto.
    const packs = ["rodaje", "postproduccion"]
      .map(g => ({ g, faltan: textosFijasDeGrupo(condicionesGuardadas, g).filter(t => !draft.condiciones.includes(t)) }))
      .filter(p => p.faltan.length > 0);
    $panel.innerHTML = `
      ${packs.map(p => `<button class="menu-item es-pack" type="button" data-pack="${p.g}">
           <span class="menu-item-nombre">Pack: condiciones de ${GRUPOS_CONDICION[p.g].toLowerCase()}</span>
           <span class="menu-item-precio">+${p.faltan.length}</span>
         </button>`).join("")}
      ${packs.length ? `<div class="menu-sep"></div>` : ""}
      ${disponibles.length
        ? disponibles.map(c => `<button class="menu-item es-larga" type="button" data-cond="${c.id}">
             <span class="menu-item-nombre">${escapeHtml(c.texto)}</span>
             <span class="menu-item-precio">${GRUPOS_CONDICION[c.grupo || "generales"]}</span>
             <span class="icon-btn btn-olvidar-cond" data-cond-borrar="${c.id}" title="Borrar de la lista guardada">✕</span>
           </button>`).join("")
        : `<p class="menu-vacio">${(condicionesGuardadas || []).length ? "Ya has añadido todas las que tienes guardadas." : "No tienes condiciones guardadas."}</p>`}
      <div class="menu-sep"></div>
      <button class="menu-item es-accion" type="button" id="mi-nueva-condicion">✎ Escribir una nueva…</button>`;

    $panel.querySelectorAll("[data-pack]").forEach(btn => {
      btn.addEventListener("click", () => {
        const g = btn.dataset.pack;
        const faltan = textosFijasDeGrupo(condicionesGuardadas, g).filter(t => !draft.condiciones.includes(t));
        draft.condiciones.push(...faltan);
        cerrarMenus();
        pintarCondiciones();
        toastOk(`Añadidas ${faltan.length} condiciones de ${GRUPOS_CONDICION[g].toLowerCase()}.`);
      });
    });
    $panel.querySelectorAll("[data-cond]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        if (e.target.closest("[data-cond-borrar]")) return;
        const c = (condicionesGuardadas || []).find(x => x.id === btn.dataset.cond);
        if (!c) return;
        draft.condiciones.push(c.texto);
        cerrarMenus();
        pintarCondiciones();
      });
    });
    $panel.querySelectorAll("[data-cond-borrar]").forEach(x => {
      x.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = x.dataset.condBorrar;
        if (!await confirmar({
          titulo: "¿Borrar la condición guardada?",
          mensaje: "Dejará de ofrecerse al hacer presupuestos. Los presupuestos que ya la usan la conservan: guardan su propia copia del texto.",
          confirmar: "Borrar", peligroso: true,
        })) return;
        const { error } = await borrarCondicion(id);
        if (error) { toastError("No se ha podido borrar: " + error); return; }
        condicionesGuardadas.splice(condicionesGuardadas.findIndex(y => y.id === id), 1);
        pintarMenuCondiciones();
        toastOk("Condición borrada de la lista guardada.");
      });
    });
    $panel.querySelector("#mi-nueva-condicion")?.addEventListener("click", () => {
      cerrarMenus();
      container.querySelector("#form-condicion").classList.remove("hidden");
      container.querySelector("#cond-nueva").focus();
    });
  }

  container.querySelector("#btn-cancelar-condicion")?.addEventListener("click", () => {
    container.querySelector("#form-condicion").classList.add("hidden");
  });
  container.querySelector("#btn-add-condicion")?.addEventListener("click", async () => {
    const $input = container.querySelector("#cond-nueva");
    const texto = $input.value.trim();
    if (!texto) { toastError("Escribe la condición antes de añadirla."); $input.focus(); return; }
    const { data, error } = await crearCondicion({ texto, orden: (condicionesGuardadas || []).length });
    if (error) { toastError("No se ha podido guardar: " + error); return; }
    condicionesGuardadas.push(Array.isArray(data) ? data[0] : data);
    if (!draft.condiciones.includes(texto)) draft.condiciones.push(texto);
    $input.value = "";
    container.querySelector("#form-condicion").classList.add("hidden");
    pintarCondiciones();
    toastOk("Condición añadida a este presupuesto y guardada para la próxima vez.");
  });
pintarCondiciones();

  pintarLineas();
  actualizar();
  pintarPasos();
  mostrarPaso();
  container.querySelector("#btn-add-linea").addEventListener("click", () => { draft.lineas.push(lineaVacia()); pintarLineas(); actualizar(); });
  ["#f-iva", "#f-retencion", "#f-cliente", "#f-numero", "#f-descuento-valor"].forEach(sel => container.querySelector(sel)?.addEventListener("input", actualizar));
  container.querySelector("#f-descuento-tipo")?.addEventListener("change", actualizar);

  const $formNuevoProyecto = container.querySelector("#nuevo-proyecto-form");
  container.querySelector("#btn-cancelar-proyecto").addEventListener("click", () => $formNuevoProyecto.classList.add("hidden"));
  container.querySelector("#btn-crear-proyecto").addEventListener("click", async () => {
    const nombre = container.querySelector("#np-nombre").value.trim();
    if (!nombre) { toastError("Ponle un nombre al proyecto."); return; }
    const precio = Number(container.querySelector("#np-precio").value || 0);
    const categoria_servicio = container.querySelector("#np-categoria").value;
    const fecha_inicio = container.querySelector("#np-fecha").value || todayIso();
    const cliente_id = container.querySelector("#f-cliente").value || null;
    const payload = { nombre, cliente_id, fecha_inicio, precio_acordado: precio, categoria_servicio, forma_pago: "transferencia", estado_facturacion: "pendiente" };
    const { data, error } = await db.from("proyectos").insert(payload).exec();
    if (error) { toastError("Error creando el proyecto: " + error); return; }
    const nuevo = Array.isArray(data) ? data[0] : data;
    proyectosDisponibles.push({ id: nuevo.id, nombre: nuevo.nombre, precio_acordado: precio });

    // Rellena la última línea si está vacía; si no, añade una nueva.
    const ultima = draft.lineas[draft.lineas.length - 1];
    const target = (ultima && !ultima.concepto && !ultima.proyecto_id)
      ? ultima
      : (draft.lineas.push(lineaVacia()), draft.lineas[draft.lineas.length - 1]);
    target.concepto = nombre;
    target.precio = precio;
    target.proyecto_id = nuevo.id;

    container.querySelector("#np-nombre").value = "";
    container.querySelector("#np-precio").value = "";
    $formNuevoProyecto.classList.add("hidden");
    pintarMenuProyectos();
    pintarLineas();
    actualizar();
    toastOk(`Proyecto "${nombre}" creado y añadido a la línea.`);
  });

  async function guardar(payloadExtra) {
    const calc = actualizar();
    const payload = {
      cliente_id: container.querySelector("#f-cliente").value,
      proyecto_id: draft.proyecto_id || null,
      numero: container.querySelector("#f-numero").value.trim(),
      tipo: draft.tipo,
      fecha: container.querySelector("#f-fecha").value,
      fecha_vencimiento: container.querySelector("#f-vencimiento").value || null,
      lineas: draft.lineas,
      estado: container.querySelector("#f-estado").value,
      descuento_tipo: draft.descuento_tipo || "porcentaje",
      descuento_valor: Number(draft.descuento_valor || 0),
      condiciones: draft.condiciones || [],
      proyecto_nombre: (container.querySelector("#f-proyecto-nombre")?.value || draft.proyecto_nombre || "").trim() || null,
      ...calc,
      ...payloadExtra,
    };
    // calcularFactura devuelve extras que NO son columnas de la tabla
    // (subtotal, desgloses...). Se quitan antes de escribir para que Supabase
    // no rechace el INSERT/UPDATE por columnas inexistentes.
    delete payload.subtotal;
    delete payload.descuento_lineas;
    delete payload.descuento_importe;
    const { data, error } = facturaId
      ? await db.from("facturas").update(payload).eq("id", facturaId).exec()
      : await db.from("facturas").insert(payload).exec();
    if (error) { toastError("Error guardando: " + error); return null; }
    const idGuardada = facturaId || (Array.isArray(data) ? data[0]?.id : data?.id);
    // Solo las FACTURAS alimentan factura_proyectos (de ahí salen los ingresos
    // del ledger). Un presupuesto no es un ingreso, y crearle vínculos era
    // además lo que provocaba que al reabrirlo se perdieran los conceptos.
    if (idGuardada && payload.tipo === "factura") await sincronizarFacturaProyectos(idGuardada, draft.lineas);
    return idGuardada;
  }

  container.querySelector("#btn-guardar").addEventListener("click", async () => {
    if (await guardar()) {
      toastOk(`${draft.tipo === "presupuesto" ? "Presupuesto" : "Factura"} ${container.querySelector("#f-numero").value.trim()} guardada.`);
      location.hash = volver;
    }
  });

  container.querySelector("#btn-borrar-doc")?.addEventListener("click", async () => {
    if (!await confirmarBorrado(`el presupuesto ${draft.numero}`)) return;
    const { error } = await db.from("facturas").delete().eq("id", facturaId).exec();
    if (error) { toastError("Error eliminando: " + error); return; }
    toastOk(`Presupuesto ${draft.numero} eliminado.`);
    location.hash = volver;
  });

  container.querySelector("#btn-convertir")?.addEventListener("click", async () => {
    if (!await confirmar({
      titulo: "¿Convertir en factura?",
      mensaje: "Se le asignará el siguiente número de la serie de facturas.",
      confirmar: "Convertir",
    })) return;
    const nuevoNumero = await nextNumero();
    draft.tipo = "factura";
    container.querySelector("#f-numero").value = nuevoNumero;
    actualizar();
    const idGuardada = await guardar({ tipo: "factura", numero: nuevoNumero });
    if (idGuardada) {
      toastOk(`Convertido en la factura ${nuevoNumero}.`);
      location.hash = `#/facturacion/${idGuardada}`;
    }
  });

  // Un presupuesto aceptado es el nacimiento de un proyecto. Esto lo crea sin
  // tener que teclearlo otra vez y lo deja vinculado, de modo que a partir de
  // ahí aparece en Proyectos y en Facturación mensual.
  container.querySelector("#btn-convertir-proyecto")?.addEventListener("click", async () => {
    if (draft.proyecto_id) { location.hash = `#/proyectos/${draft.proyecto_id}`; return; }
    const nombre = (container.querySelector("#f-proyecto-nombre")?.value || "").trim();
    if (!nombre) {
      toastError("Ponle nombre al proyecto arriba, en el campo Proyecto, antes de convertirlo.");
      container.querySelector("#f-proyecto-nombre")?.focus();
      return;
    }
    const calc = actualizar();
    const precio = Number(calc?.base_imponible || 0);
    if (!await confirmar({
      titulo: "¿Crear el proyecto?",
      mensaje: `Se creará "${nombre}" con un precio acordado de ${eur(precio)} y quedará vinculado a este presupuesto, que pasará a "Aceptado".`,
      confirmar: "Crear proyecto",
    })) return;

    const { data, error } = await db.from("proyectos").insert({
      nombre,
      cliente_id: container.querySelector("#f-cliente").value || null,
      precio_acordado: precio,
      fecha_inicio: container.querySelector("#f-fecha").value || todayIso(),
      estado: "en_curso",
    }).exec();
    if (error) { toastError("No se ha podido crear el proyecto: " + error); return; }
    const nuevoId = Array.isArray(data) ? data[0]?.id : data?.id;
    if (!nuevoId) { toastError("El proyecto se ha creado pero no ha devuelto id; revísalo en Proyectos."); return; }

    draft.proyecto_id = nuevoId;
    const idGuardada = await guardar({ proyecto_id: nuevoId, estado: "pagada" });
    if (idGuardada) {
      toastOk(`Proyecto "${nombre}" creado y vinculado al presupuesto.`);
      location.hash = `#/proyectos/${nuevoId}`;
    }
  });

  // Una factura sin NIF o sin dirección del cliente no es válida ante Hacienda.
  // Antes se podía exportar igual, con los huecos en blanco y sin avisar, así
  // que era fácil mandarla a un cliente creyendo que estaba completa.
  // Devuelve la lista de campos que faltan (vacía si está todo).
  function camposClienteQueFaltan() {
    const cliente = (clientes || []).find(c => c.id === container.querySelector("#f-cliente")?.value);
    return faltanDatosFacturacion(cliente);
  }

  function pintarAvisoCliente() {
    const $aviso = container.querySelector("#aviso-cliente");
    if (!$aviso) return;
    // Los presupuestos no son documento fiscal: no se exige NIF ni dirección.
    if (draft.tipo !== "factura") { $aviso.innerHTML = ""; return; }
    const faltan = camposClienteQueFaltan();
    const clienteId = container.querySelector("#f-cliente")?.value || "";
    $aviso.innerHTML = faltan.length ? `
      <div class="hint-box" style="border-left:3px solid var(--orange-fg); margin-bottom:4px;">
        <strong>Faltan datos de facturación del cliente:</strong> ${faltan.join(", ")}.
        Una factura sin NIF ni dirección no es válida ante Hacienda, así que el PDF
        se descargará marcado como <strong>${MARCA_BORRADOR}</strong>.
        ${clienteId ? `<br><a href="#/clientes">Completar los datos del cliente →</a>` : ""}
      </div>` : "";
  }

  container.querySelector("#f-cliente")?.addEventListener("change", pintarAvisoCliente);
  pintarAvisoCliente();

  container.querySelector("#btn-pdf").addEventListener("click", () => {
    const calc = actualizar();
    const cliente = (clientes || []).find(c => c.id === container.querySelector("#f-cliente").value);
    const faltan = draft.tipo === "factura" ? camposClienteQueFaltan() : [];
    // Nombre del proyecto REAL: antes el PDF ponía en "Proyecto" el primer
    // concepto de la lista, que casi nunca coincide con el proyecto elegido.
    const idsProyecto = [...new Set(draft.lineas.map(l => l.proyecto_id).filter(Boolean))];
    const proyectoNombre = (container.querySelector("#f-proyecto-nombre")?.value || "").trim()
      || (idsProyecto.length === 1
            ? (proyectosDisponibles || []).find(p => p.id === idsProyecto[0])?.nombre
            : null);
    const docParaPdf = {
      numero: container.querySelector("#f-numero").value.trim(),
      tipo: draft.tipo,
      fecha: container.querySelector("#f-fecha").value,
      lineas: draft.lineas,
      proyectoNombre,
      descuento_tipo: draft.descuento_tipo,
      descuento_valor: draft.descuento_valor,
      condiciones: draft.condiciones,
      // El generador estampa la marca de agua si recibe este campo.
      marcaAgua: faltan.length ? MARCA_BORRADOR : null,
    };
    if (faltan.length) {
      toastError(`Previsualización: faltan ${faltan.join(", ")} del cliente. El PDF sale marcado como borrador.`);
    }
    descargarPdfDocumento(docParaPdf, cliente);
  });
}

function cargarJsPdf() {
  return new Promise((resolve, reject) => {
    if (window.jspdf) return resolve(window.jspdf);
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    script.onload = () => resolve(window.jspdf);
    script.onerror = () => reject(new Error("No se ha podido cargar el generador de PDF (sin conexión a internet)."));
    document.head.appendChild(script);
  });
}

// Genera y descarga el PDF de un documento (factura o presupuesto) a partir
// de sus datos ya guardados — usado tanto por el icono de descarga rápida en
// las listas como por el botón "Descargar PDF" del editor, para no duplicar
// la lógica de maquetación en dos sitios.
async function descargarPdfDocumento(doc, cliente) {
  let jspdfNs;
  try { jspdfNs = await cargarJsPdf(); } catch (e) { toastError(e.message); return; }
  const { jsPDF } = jspdfNs;
  const pdf = new jsPDF({ unit: "pt", format: "a4" });

  const numero = doc.numero;
  const esPresupuesto = doc.tipo === "presupuesto";
  const fechaStr = dateEs(doc.fecha);
  const lineas = (doc.lineas || []).filter(l => (l.concepto || "").trim() || Number(l.precio || 0));

  try {
    if (esPresupuesto) {
      // El campo "Proyecto" de la cabecera debe ser el PROYECTO, no el primer
      // concepto del desglose. Se resuelve, por este orden: el nombre que pase
      // el editor, el proyecto vinculado en la BD, y solo como último recurso
      // el primer concepto.
      let proyectoNombre = doc.proyectoNombre || doc.proyecto_nombre;
      if (!proyectoNombre) {
        const idsProyecto = [...new Set((doc.lineas || []).map(l => l.proyecto_id).filter(Boolean))];
        const idUnico = doc.proyecto_id || (idsProyecto.length === 1 ? idsProyecto[0] : null);
        if (idUnico) {
          const { data: p } = await db.from("proyectos").select("nombre").eq("id", idUnico).single().exec();
          proyectoNombre = p?.nombre;
        }
      }
      if (!proyectoNombre) proyectoNombre = lineas[0]?.concepto || "Proyecto";

      const lineasPresupuesto = lineas.map(l => {
        const d = desglosarLinea(l);
        return {
          concepto: l.concepto || "—",
          descripcion: l.descripcion || "",
          importe: d.neto,
          // Para que el PDF pueda pintar el precio original tachado encima del
          // final. Solo se manda si hay descuento; si no, va a null y la línea
          // se dibuja como siempre, con un único importe.
          importeOriginal: d.descuento > 0 ? d.bruto : null,
          descuentoEtiqueta: d.descuento > 0
            ? ((l.descuento_tipo || "porcentaje") === "porcentaje"
                ? `−${Number(l.descuento_valor || 0)}%`
                : `−${eur(Number(l.descuento_valor || 0))}`)
            : "",
        };
      });
      const subtotalNeto = lineasPresupuesto.reduce((s, l) => s + l.importe, 0);
      const descuentoImporte = aplicarDescuentoGlobal(subtotalNeto, doc.descuento_tipo, doc.descuento_valor);
      const logo = await cargarLogoDataUrl();
      crearPresupuestoPdf(pdf, CONFIG_NEGOCIO, numero, fechaStr, proyectoNombre, lineasPresupuesto, logo, {
        condicionesExtra: Array.isArray(doc.condiciones) ? doc.condiciones : [],
        descuento: descuentoImporte > 0
          ? { tipo: doc.descuento_tipo || "porcentaje", valor: Number(doc.descuento_valor || 0), importe: descuentoImporte }
          : null,
      });
    } else {
      const clienteFactura = { nombre: cliente?.nombre || "Cliente", nif: cliente?.nif || "", direccion: cliente?.direccion || "" };
      const lineasFactura = lineas.map(l => ({ concepto: l.concepto || "—", cantidad: Number(l.cantidad || 1), precio: Number(l.precio || 0) }));
      crearFacturaPdf(pdf, CONFIG_NEGOCIO, numero, fechaStr, clienteFactura, lineasFactura, "");
    }
  } catch (e) {
    toastError("Error generando el PDF: " + e.message);
    return;
  }

  // Marca de agua en diagonal cuando el documento no es fiscalmente válido
  // (por ejemplo, faltan el NIF o la dirección del cliente). Va DESPUÉS de
  // dibujar el contenido para que quede por encima, y con opacidad baja para
  // no impedir la lectura: es una previsualización, no una factura.
  if (doc.marcaAgua) {
    try {
      const w = pdf.internal.pageSize.getWidth();
      const h = pdf.internal.pageSize.getHeight();
      if (pdf.GState) pdf.setGState(new pdf.GState({ opacity: 0.16 }));
      pdf.setFont("Poppins", "bold");
      pdf.setFontSize(30);
      pdf.setTextColor(180, 69, 58);
      pdf.text(doc.marcaAgua, w / 2, h / 2, { align: "center", angle: 30 });
      if (pdf.GState) pdf.setGState(new pdf.GState({ opacity: 1 }));
      pdf.setTextColor(0, 0, 0);
    } catch { /* si el motor no soporta opacidad, se omite la marca */ }
  }

  const sufijo = doc.marcaAgua ? "-BORRADOR" : "";
  pdf.save(`${esPresupuesto ? "presupuesto" : "factura"}-${numero}${sufijo}.pdf`);
}
