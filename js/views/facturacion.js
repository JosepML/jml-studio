import { db } from "../supabase.js";
import { calcularFactura, round2 } from "../utils/invoice-calc.js";
import { ESTADOS_FACTURA, eur, dateEs, todayIso } from "../utils/format.js";
import { escapeHtml, escapeAttr } from "./clientes.js";
import { CONFIG_NEGOCIO } from "../utils/config-negocio.js";
import { crearFacturaPdf, crearPresupuestoPdf, cargarLogoDataUrl } from "../utils/pdf-documentos.js";

const EMISOR = CONFIG_NEGOCIO.emisor;

export async function renderFacturacion(container, param) {
  if (param && param.startsWith("nuevo-desde-proyecto:")) return renderEditor(container, { proyectoId: param.split(":")[1] });
  if (param === "nuevo") return renderEditor(container, {});
  if (param) return renderEditor(container, { facturaId: param });
  return renderLista(container);
}

async function renderLista(container) {
  const [{ data: facturas, error }, { data: clientes }] = await Promise.all([
    db.from("facturas").select("*").order("fecha", { ascending: false }).exec(),
    db.from("clientes").select("id,nombre").exec(),
  ]);
  if (error) { container.innerHTML = `<p class="muted">Error: ${error}</p>`; return; }
  const clientesMap = Object.fromEntries((clientes || []).map(c => [c.id, c.nombre]));

  const anio = new Date().getFullYear();
  const facturasReales = (facturas || []).filter(f => f.tipo === "factura");
  const totalFacturadoAnio = facturasReales.filter(f => (f.fecha || "").startsWith(String(anio))).reduce((s, f) => s + Number(f.total || 0), 0);
  const pendientesCobro = facturasReales.filter(f => f.estado !== "pagada").length;
  const presupuestosAbiertos = (facturas || []).filter(f => f.tipo === "presupuesto" && f.estado !== "pagada").length;

  // --- Integridad de la numeración (inspirado en el requisito de Verifactu de
  // que la serie de facturas sea correlativa y sin huecos ni duplicados) ---
  // Solo avisa; no bloquea nada. Útil para detectar números repetidos o
  // saltos antes de que lo note un cliente o la Agencia Tributaria.
  const numerosPorAnio = {};
  facturasReales.forEach(f => {
    const y = (f.fecha || "").slice(0, 4);
    if (!y) return;
    (numerosPorAnio[y] ||= []).push(f.numero);
  });
  const avisosIntegridad = [];
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

  container.innerHTML = `
    <div class="grid grid-4" style="margin-bottom:20px;">
      <div class="card kpi"><div class="label">Documentos</div><div class="value">${(facturas || []).length}</div></div>
      <div class="card kpi"><div class="label">Facturado ${anio}</div><div class="value">${eur(totalFacturadoAnio)}</div></div>
      <div class="card kpi"><div class="label">Facturas sin cobrar</div><div class="value">${pendientesCobro}</div></div>
      <div class="card kpi"><div class="label">Presupuestos abiertos</div><div class="value">${presupuestosAbiertos}</div></div>
    </div>

    ${avisosIntegridad.length ? `<div class="ai-banner" style="border-left-color:var(--orange-fg); background:var(--orange-bg); color:var(--orange-fg);">⚠️ Revisa la numeración de facturas: ${avisosIntegridad.map(escapeHtml).join(" · ")}</div>` : ""}

    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:14px;">
        <input id="f-buscar" type="text" placeholder="Buscar por número o cliente…" style="flex:1; min-width:220px;">
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <select id="f-tipo-filtro">
            <option value="">Todos los tipos</option>
            <option value="factura">Facturas</option>
            <option value="presupuesto">Presupuestos</option>
          </select>
          <select id="f-estado-filtro">
            <option value="">Todos los estados</option>
            ${Object.entries(ESTADOS_FACTURA).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}
          </select>
          <button class="btn btn-primary" id="btn-nueva">+ Nuevo documento</button>
        </div>
      </div>
      <div id="facturas-list">Cargando…</div>
    </div>`;

  container.querySelector("#btn-nueva").addEventListener("click", () => location.hash = "#/facturacion/nuevo");

  const $list = container.querySelector("#facturas-list");
  const $buscar = container.querySelector("#f-buscar");
  const $tipoFiltro = container.querySelector("#f-tipo-filtro");
  const $estadoFiltro = container.querySelector("#f-estado-filtro");

  function pintar() {
    const q = $buscar.value.trim().toLowerCase();
    const tipoSel = $tipoFiltro.value;
    const estadoSel = $estadoFiltro.value;
    const filtradas = (facturas || []).filter(f => {
      if (tipoSel && f.tipo !== tipoSel) return false;
      if (estadoSel && f.estado !== estadoSel) return false;
      if (q) {
        const cliente = (clientesMap[f.cliente_id] || "").toLowerCase();
        if (!f.numero.toLowerCase().includes(q) && !cliente.includes(q)) return false;
      }
      return true;
    });

    if (!facturas || !facturas.length) { $list.innerHTML = `<div class="empty-state">Todavía no hay facturas ni presupuestos. Créalo desde aquí o pulsa "Generar factura" en la ficha de un proyecto.</div>`; return; }
    if (!filtradas.length) { $list.innerHTML = `<div class="empty-state">Ningún documento coincide con la búsqueda.</div>`; return; }

    $list.innerHTML = `<table>
      <thead><tr><th>Nº</th><th>Cliente</th><th>Tipo</th><th>Fecha</th><th>Total</th><th>Estado</th></tr></thead>
      <tbody>${filtradas.map(f => `
        <tr class="clickable" data-id="${f.id}">
          <td><strong>${escapeHtml(f.numero)}</strong></td>
          <td>${escapeHtml(clientesMap[f.cliente_id] || "—")}</td>
          <td>${f.tipo === "presupuesto" ? "Presupuesto" : "Factura"}</td>
          <td>${dateEs(f.fecha)}</td>
          <td>${eur(f.total)}</td>
          <td><span class="badge" style="background:${ESTADOS_FACTURA[f.estado].bg};color:${ESTADOS_FACTURA[f.estado].fg}">${ESTADOS_FACTURA[f.estado].label}</span></td>
        </tr>`).join("")}</tbody></table>`;

    $list.querySelectorAll("tr[data-id]").forEach(tr => tr.addEventListener("click", () => location.hash = `#/facturacion/${tr.dataset.id}`));
  }

  $buscar.addEventListener("input", pintar);
  $tipoFiltro.addEventListener("change", pintar);
  $estadoFiltro.addEventListener("change", pintar);
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

export async function nextNumero() {
  const year = new Date().getFullYear();
  const { data } = await db.from("facturas").select("id").eq("tipo", "factura").gte("fecha", `${year}-01-01`).lte("fecha", `${year}-12-31`).exec();
  const n = (data?.length || 0) + 1;
  return `${String(n).padStart(2, "0")}-${year}`;
}

async function renderEditor(container, { proyectoId, facturaId }) {
  const [{ data: clientes }, { data: proyectosDisponibles }] = await Promise.all([
    db.from("clientes").select("*").order("nombre").exec(),
    db.from("proyectos").select("id,nombre").order("nombre").exec(),
  ]);
  let draft = { numero: "", tipo: "factura", fecha: todayIso(), fecha_vencimiento: "", cliente_id: clientes?.[0]?.id || "", proyecto_id: null, lineas: [{ concepto: "", cantidad: 1, precio: 0, proyecto_id: "" }], iva_pct: 21, retencion_pct: 0, estado: "borrador" };
  let origenProyectoTexto = "";

  if (facturaId) {
    const [{ data }, { data: vinculos }] = await Promise.all([
      db.from("facturas").select("*").eq("id", facturaId).single().exec(),
      db.from("factura_proyectos").select("importe,proyecto_id,proyectos(nombre)").eq("factura_id", facturaId).exec(),
    ]);
    if (data) {
      // Si esta factura tiene proyectos vinculados (asignados desde Facturación
      // mensual, p. ej. varios proyectos con el mismo número de factura), esa
      // vinculación manda: cada proyecto se desglosa en su propia línea. Si no
      // hay vínculos (factura creada/editada a mano), se usan las líneas ya
      // guardadas en la propia factura.
      const lineasDesdeVinculos = (vinculos && vinculos.length)
        ? vinculos.map(v => ({ concepto: v.proyectos?.nombre || "Proyecto", cantidad: 1, precio: Number(v.importe || 0), proyecto_id: v.proyecto_id }))
        : null;
      const lineas = lineasDesdeVinculos || (data.lineas?.length ? data.lineas.map(l => ({ proyecto_id: "", ...l })) : [{ concepto: "", cantidad: 1, precio: 0, proyecto_id: "" }]);
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
      draft.lineas = [{ concepto: proyecto.nombre, cantidad: 1, precio: Number(proyecto.precio_acordado || 0), proyecto_id: proyecto.id }];
      origenProyectoTexto = `Generada automáticamente desde el proyecto "${proyecto.nombre}" — revisa los datos antes de enviar.`;
    }
    draft.numero = await nextNumero();
  } else {
    draft.numero = await nextNumero();
  }

  container.innerHTML = `
    ${origenProyectoTexto ? `<div class="ai-banner">✨ ${escapeHtml(origenProyectoTexto)}</div>` : ""}
    <div class="grid grid-2">
      <div class="card">
        <h3>Datos de la factura</h3>
        <div class="row">
          <div class="field"><label>Cliente</label>
            <select id="f-cliente">${(clientes || []).map(c => `<option value="${c.id}" ${c.id === draft.cliente_id ? "selected" : ""}>${escapeHtml(c.nombre)}</option>`).join("")}</select>
          </div>
          <div class="field"><label>Tipo</label>
            <select id="f-tipo">
              <option value="factura" ${draft.tipo === "factura" ? "selected" : ""}>Factura</option>
              <option value="presupuesto" ${draft.tipo === "presupuesto" ? "selected" : ""}>Presupuesto</option>
            </select>
          </div>
        </div>
        <div class="row">
          <div class="field"><label>Nº</label><input id="f-numero" value="${escapeAttr(draft.numero)}"></div>
          <div class="field"><label>Fecha</label><input type="date" id="f-fecha" value="${draft.fecha}"></div>
          <div class="field"><label>Vencimiento</label><input type="date" id="f-vencimiento" value="${draft.fecha_vencimiento || ""}"></div>
        </div>

        <label>Líneas</label>
        <div id="lineas-wrap"></div>
        <button class="btn btn-ghost" id="btn-add-linea" type="button" style="margin-bottom:14px;">+ Añadir línea</button>

        <div class="row">
          <div class="field"><label>IVA %</label><input type="number" id="f-iva" value="${draft.iva_pct}"></div>
          <div class="field"><label>Retención IRPF %</label><input type="number" id="f-retencion" value="${draft.retencion_pct}"></div>
          <div class="field"><label>Estado de cobro</label>
            <select id="f-estado">${Object.entries(ESTADOS_FACTURA).map(([k, v]) => `<option value="${k}" ${k === draft.estado ? "selected" : ""}>${v.label}</option>`).join("")}</select>
          </div>
        </div>

        <div id="totales" style="margin:14px 0; font-size:15px;"></div>

        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <button class="btn btn-ghost" id="btn-guardar">Guardar borrador</button>
          <button class="btn btn-dark" id="btn-pdf">Descargar PDF</button>
        </div>
      </div>

      <div class="card">
        <h3>Vista previa en vivo</h3>
        <div id="preview" style="border:1px solid var(--border); padding:20px; background:#FBFBFC; font-size:13px;"></div>
      </div>
    </div>`;

  const $lineasWrap = container.querySelector("#lineas-wrap");
  function pintarLineas() {
    $lineasWrap.innerHTML = `
      <p class="muted" style="font-size:12px; margin:-4px 0 8px;">Si una factura cubre varios proyectos, asigna cada línea a su proyecto: así aparecerá repartida correctamente en cada ficha de proyecto y en la vista mensual.</p>
      ${draft.lineas.map((l, i) => `
      <div class="row" data-idx="${i}" style="margin-bottom:8px; align-items:flex-end;">
        <div style="flex:3"><input class="linea-concepto" placeholder="Concepto" value="${escapeAttr(l.concepto)}"></div>
        <div style="flex:1"><input class="linea-cantidad" type="number" step="1" value="${l.cantidad}" placeholder="Uds."></div>
        <div style="flex:1"><input class="linea-precio" type="number" step="0.01" value="${l.precio}" placeholder="Precio"></div>
        <div style="flex:2">
          <select class="linea-proyecto">
            <option value="">(sin proyecto)</option>
            ${(proyectosDisponibles || []).map(p => `<option value="${p.id}" ${p.id === l.proyecto_id ? "selected" : ""}>${escapeHtml(p.nombre)}</option>`).join("")}
          </select>
        </div>
        <div style="flex:0"><button class="btn btn-ghost btn-quitar-linea" type="button">✕</button></div>
      </div>`).join("")}`;
    $lineasWrap.querySelectorAll("[data-idx]").forEach(row => {
      const idx = Number(row.dataset.idx);
      row.querySelector(".linea-concepto").addEventListener("input", e => { draft.lineas[idx].concepto = e.target.value; actualizar(); });
      row.querySelector(".linea-cantidad").addEventListener("input", e => { draft.lineas[idx].cantidad = Number(e.target.value || 0); actualizar(); });
      row.querySelector(".linea-precio").addEventListener("input", e => { draft.lineas[idx].precio = Number(e.target.value || 0); actualizar(); });
      row.querySelector(".linea-proyecto").addEventListener("change", e => { draft.lineas[idx].proyecto_id = e.target.value; });
      row.querySelector(".btn-quitar-linea").addEventListener("click", () => { draft.lineas.splice(idx, 1); pintarLineas(); actualizar(); });
    });
  }

  function actualizar() {
    const ivaPct = Number(container.querySelector("#f-iva").value || 0);
    const retencionPct = Number(container.querySelector("#f-retencion").value || 0);
    const calc = calcularFactura({ lineas: draft.lineas, ivaPct, retencionPct });
    container.querySelector("#totales").innerHTML = `
      Base imponible: <strong>${eur(calc.base_imponible)}</strong> ·
      IVA: <strong>${eur(calc.iva_importe)}</strong> ·
      Retención: <strong>-${eur(calc.retencion_importe)}</strong><br>
      <span style="font-size:22px; font-weight:700;">Total: ${eur(calc.total)}</span>`;

    const cliente = (clientes || []).find(c => c.id === container.querySelector("#f-cliente").value);
    container.querySelector("#preview").innerHTML = `
      <p style="font-weight:700; font-size:15px;">${container.querySelector("#f-tipo").value === "presupuesto" ? "PRESUPUESTO" : "FACTURA"} Nº ${escapeHtml(container.querySelector("#f-numero").value)}</p>
      <p class="muted">${EMISOR.nombre} — ${EMISOR.actividad}</p>
      <hr style="border:none;border-top:1px solid var(--border);">
      <p class="muted" style="margin-bottom:2px;">FACTURAR A</p>
      <p><strong>${escapeHtml(cliente?.nombre || "—")}</strong><br>${escapeHtml(cliente?.nif || "")}</p>
      <table style="margin:12px 0;">${draft.lineas.map(l => `<tr><td>${escapeHtml(l.concepto || "—")} (${l.cantidad || 1} uds.)</td><td style="text-align:right">${eur((l.cantidad || 1) * (l.precio || 0))}</td></tr>`).join("")}</table>
      <hr style="border:none;border-top:1px solid var(--border);">
      <p>Base imponible: ${eur(calc.base_imponible)}<br>IVA ${ivaPct}%: ${eur(calc.iva_importe)}<br>Retención IRPF ${retencionPct}%: -${eur(calc.retencion_importe)}</p>
      <p style="font-weight:700; font-size:15px;">TOTAL: ${eur(calc.total)}</p>`;

    return calc;
  }

  pintarLineas();
  actualizar();
  container.querySelector("#btn-add-linea").addEventListener("click", () => { draft.lineas.push({ concepto: "", cantidad: 1, precio: 0, proyecto_id: "" }); pintarLineas(); actualizar(); });
  ["#f-iva", "#f-retencion", "#f-cliente", "#f-numero", "#f-tipo"].forEach(sel => container.querySelector(sel).addEventListener("input", actualizar));

  container.querySelector("#btn-guardar").addEventListener("click", async () => {
    const calc = actualizar();
    const payload = {
      cliente_id: container.querySelector("#f-cliente").value,
      proyecto_id: draft.proyecto_id || null,
      numero: container.querySelector("#f-numero").value.trim(),
      tipo: container.querySelector("#f-tipo").value,
      fecha: container.querySelector("#f-fecha").value,
      fecha_vencimiento: container.querySelector("#f-vencimiento").value || null,
      lineas: draft.lineas,
      estado: container.querySelector("#f-estado").value,
      ...calc,
    };
    const { data, error } = facturaId
      ? await db.from("facturas").update(payload).eq("id", facturaId).exec()
      : await db.from("facturas").insert(payload).exec();
    if (error) { alert("Error guardando: " + error); return; }
    const idGuardada = facturaId || (Array.isArray(data) ? data[0]?.id : data?.id);
    if (idGuardada) await sincronizarFacturaProyectos(idGuardada, draft.lineas);
    location.hash = "#/facturacion";
  });

  container.querySelector("#btn-pdf").addEventListener("click", () => generarPdf(draft, actualizar(), container, clientes, proyectosDisponibles));
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

async function generarPdf(draft, calc, container, clientes, proyectosDisponibles) {
  let jspdfNs;
  try { jspdfNs = await cargarJsPdf(); } catch (e) { alert(e.message); return; }
  const { jsPDF } = jspdfNs;
  const doc = new jsPDF({ unit: "pt", format: "a4" });

  const numero = container.querySelector("#f-numero").value.trim();
  const esPresupuesto = container.querySelector("#f-tipo").value === "presupuesto";
  const fechaStr = dateEs(container.querySelector("#f-fecha").value);
  const cliente = (clientes || []).find(c => c.id === container.querySelector("#f-cliente").value) || { nombre: "Cliente" };
  const lineas = draft.lineas.filter(l => (l.concepto || "").trim() || Number(l.precio || 0));

  try {
    if (esPresupuesto) {
      const proyectoRef = (proyectosDisponibles || []).find(p => p.id === lineas[0]?.proyecto_id);
      const proyectoNombre = proyectoRef?.nombre || lineas[0]?.concepto || "Proyecto";
      const lineasPresupuesto = lineas.map(l => ({
        concepto: l.concepto || "—",
        descripcion: "",
        importe: Number(l.cantidad || 1) * Number(l.precio || 0),
      }));
      const logo = await cargarLogoDataUrl();
      crearPresupuestoPdf(doc, CONFIG_NEGOCIO, numero, fechaStr, proyectoNombre, lineasPresupuesto, logo);
    } else {
      const clienteFactura = { nombre: cliente.nombre, nif: cliente.nif || "", direccion: cliente.direccion || "" };
      const lineasFactura = lineas.map(l => ({ concepto: l.concepto || "—", cantidad: Number(l.cantidad || 1), precio: Number(l.precio || 0) }));
      crearFacturaPdf(doc, CONFIG_NEGOCIO, numero, fechaStr, clienteFactura, lineasFactura, "");
    }
  } catch (e) {
    alert("Error generando el PDF: " + e.message);
    return;
  }

  doc.save(`${esPresupuesto ? "presupuesto" : "factura"}-${numero}.pdf`);
}
