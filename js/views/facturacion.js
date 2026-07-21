import { db } from "../supabase.js";
import { calcularFactura, round2 } from "../utils/invoice-calc.js";
import { ESTADOS_FACTURA, eur, dateEs, todayIso } from "../utils/format.js";
import { escapeHtml, escapeAttr } from "./clientes.js";

const EMISOR = { nombre: "Josep Mira Lozano", actividad: "Producción Audiovisual", nif: "—", email: "josep.mira@gmail.com" };

export async function renderFacturacion(container, param) {
  if (param && param.startsWith("nuevo-desde-proyecto:")) return renderEditor(container, { proyectoId: param.split(":")[1] });
  if (param === "nuevo") return renderEditor(container, {});
  if (param) return renderEditor(container, { facturaId: param });
  return renderLista(container);
}

async function renderLista(container) {
  container.innerHTML = `
    <div style="display:flex; justify-content:flex-end; margin-bottom:14px;">
      <button class="btn btn-primary" id="btn-nueva">+ Nueva factura</button>
    </div>
    <div class="card"><div id="facturas-list">Cargando…</div></div>`;
  container.querySelector("#btn-nueva").addEventListener("click", () => location.hash = "#/facturacion/nuevo");

  const [{ data: facturas, error }, { data: clientes }] = await Promise.all([
    db.from("facturas").select("*").order("fecha", { ascending: false }).exec(),
    db.from("clientes").select("id,nombre").exec(),
  ]);
  const clientesMap = Object.fromEntries((clientes || []).map(c => [c.id, c.nombre]));
  const $list = container.querySelector("#facturas-list");
  if (error) { $list.innerHTML = `<p class="muted">Error: ${error}</p>`; return; }
  if (!facturas || !facturas.length) { $list.innerHTML = `<div class="empty-state">Todavía no hay facturas. Créala desde aquí o pulsa "Generar factura" en la ficha de un proyecto.</div>`; return; }

  $list.innerHTML = `<table>
    <thead><tr><th>Nº</th><th>Cliente</th><th>Tipo</th><th>Fecha</th><th>Total</th><th>Estado</th></tr></thead>
    <tbody>${facturas.map(f => `
      <tr class="clickable" data-id="${f.id}">
        <td>${escapeHtml(f.numero)}</td>
        <td>${escapeHtml(clientesMap[f.cliente_id] || "—")}</td>
        <td>${f.tipo}</td>
        <td>${dateEs(f.fecha)}</td>
        <td>${eur(f.total)}</td>
        <td><span class="badge" style="background:${ESTADOS_FACTURA[f.estado].bg};color:${ESTADOS_FACTURA[f.estado].fg}">${ESTADOS_FACTURA[f.estado].label}</span></td>
      </tr>`).join("")}</tbody></table>`;

  $list.querySelectorAll("tr[data-id]").forEach(tr => tr.addEventListener("click", () => location.hash = `#/facturacion/${tr.dataset.id}`));
}

async function nextNumero() {
  const year = new Date().getFullYear();
  const { data } = await db.from("facturas").select("id").gte("fecha", `${year}-01-01`).lte("fecha", `${year}-12-31`).exec();
  const n = (data?.length || 0) + 1;
  return `${String(n).padStart(2, "0")}-${year}`;
}

async function renderEditor(container, { proyectoId, facturaId }) {
  const { data: clientes } = await db.from("clientes").select("*").order("nombre").exec();
  let draft = { numero: "", tipo: "factura", fecha: todayIso(), fecha_vencimiento: "", cliente_id: clientes?.[0]?.id || "", proyecto_id: null, lineas: [{ concepto: "", cantidad: 1, precio: 0 }], iva_pct: 21, retencion_pct: 0, estado: "borrador" };
  let origenProyectoTexto = "";

  if (facturaId) {
    const { data } = await db.from("facturas").select("*").eq("id", facturaId).single().exec();
    if (data) draft = { ...data, lineas: data.lineas?.length ? data.lineas : [{ concepto: "", cantidad: 1, precio: 0 }] };
  } else if (proyectoId) {
    const { data: proyecto } = await db.from("proyectos").select("*").eq("id", proyectoId).single().exec();
    if (proyecto) {
      draft.proyecto_id = proyecto.id;
      draft.cliente_id = proyecto.cliente_id;
      draft.lineas = [{ concepto: proyecto.nombre, cantidad: 1, precio: Number(proyecto.precio_acordado || 0) }];
      origenProyectoTexto = proyecto.nombre;
    }
    draft.numero = await nextNumero();
  } else {
    draft.numero = await nextNumero();
  }

  container.innerHTML = `
    ${origenProyectoTexto ? `<div class="ai-banner">✨ Generada automáticamente desde el proyecto "${escapeHtml(origenProyectoTexto)}" — revisa los datos antes de enviar.</div>` : ""}
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
    $lineasWrap.innerHTML = draft.lineas.map((l, i) => `
      <div class="row" data-idx="${i}" style="margin-bottom:8px; align-items:flex-end;">
        <div style="flex:3"><input class="linea-concepto" placeholder="Concepto" value="${escapeAttr(l.concepto)}"></div>
        <div style="flex:1"><input class="linea-cantidad" type="number" step="1" value="${l.cantidad}" placeholder="Uds."></div>
        <div style="flex:1"><input class="linea-precio" type="number" step="0.01" value="${l.precio}" placeholder="Precio"></div>
        <div style="flex:0"><button class="btn btn-ghost btn-quitar-linea" type="button">✕</button></div>
      </div>`).join("");
    $lineasWrap.querySelectorAll("[data-idx]").forEach(row => {
      const idx = Number(row.dataset.idx);
      row.querySelector(".linea-concepto").addEventListener("input", e => { draft.lineas[idx].concepto = e.target.value; actualizar(); });
      row.querySelector(".linea-cantidad").addEventListener("input", e => { draft.lineas[idx].cantidad = Number(e.target.value || 0); actualizar(); });
      row.querySelector(".linea-precio").addEventListener("input", e => { draft.lineas[idx].precio = Number(e.target.value || 0); actualizar(); });
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
  container.querySelector("#btn-add-linea").addEventListener("click", () => { draft.lineas.push({ concepto: "", cantidad: 1, precio: 0 }); pintarLineas(); actualizar(); });
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
    const { error } = facturaId
      ? await db.from("facturas").update(payload).eq("id", facturaId).exec()
      : await db.from("facturas").insert(payload).exec();
    if (error) { alert("Error guardando: " + error); return; }
    location.hash = "#/facturacion";
  });

  container.querySelector("#btn-pdf").addEventListener("click", () => generarPdf(draft, actualizar(), container));
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

async function generarPdf(draft, calc, container) {
  let jspdfNs;
  try { jspdfNs = await cargarJsPdf(); } catch (e) { alert(e.message); return; }
  const { jsPDF } = jspdfNs;
  const doc = new jsPDF();
  const numero = container.querySelector("#f-numero").value;
  const tipo = container.querySelector("#f-tipo").value === "presupuesto" ? "PRESUPUESTO" : "FACTURA";

  doc.setFontSize(16); doc.text(`${tipo} Nº ${numero}`, 14, 20);
  doc.setFontSize(10); doc.text(`${EMISOR.nombre} — ${EMISOR.actividad}`, 14, 27);
  doc.text(`Fecha: ${container.querySelector("#f-fecha").value}`, 14, 33);

  let y = 45;
  doc.setFontSize(11); doc.text("Concepto", 14, y); doc.text("Uds.", 130, y); doc.text("Precio", 150, y); doc.text("Importe", 175, y);
  y += 6;
  draft.lineas.forEach(l => {
    doc.setFontSize(10);
    doc.text(String(l.concepto || "—"), 14, y);
    doc.text(String(l.cantidad || 1), 130, y);
    doc.text(eur(l.precio), 150, y);
    doc.text(eur((l.cantidad || 1) * (l.precio || 0)), 175, y);
    y += 6;
  });
  y += 6;
  doc.text(`Base imponible: ${eur(calc.base_imponible)}`, 14, y); y += 6;
  doc.text(`IVA (${calc.iva_pct}%): ${eur(calc.iva_importe)}`, 14, y); y += 6;
  doc.text(`Retención IRPF (${calc.retencion_pct}%): -${eur(calc.retencion_importe)}`, 14, y); y += 8;
  doc.setFontSize(13); doc.text(`TOTAL: ${eur(calc.total)}`, 14, y);

  doc.save(`${tipo.toLowerCase()}-${numero}.pdf`);
}
