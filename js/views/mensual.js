import { db } from "../supabase.js";
import { eur, dateEs, FORMAS_PAGO } from "../utils/format.js";
import { round2, sumaGastosDeduciblesEnRango } from "../utils/invoice-calc.js";
import { escapeHtml } from "./clientes.js";

const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

export async function renderMensual(container) {
  container.innerHTML = `<div class="empty-state">Cargando vista mensual…</div>`;

  const [{ data: proyectos, error: e1 }, { data: clientes }, { data: facturaProyectos, error: e2 }, { data: gastos }] = await Promise.all([
    db.from("proyectos").select("*").exec(),
    db.from("clientes").select("id,nombre").exec(),
    db.from("factura_proyectos").select("importe,factura_id,proyecto_id,facturas(numero,estado,fecha,tipo)").exec(),
    db.from("gastos").select("*").exec(),
  ]);
  if (e1 || e2) { container.innerHTML = `<p class="muted">Error cargando datos: ${e1 || e2}</p>`; return; }

  const clientesMap = Object.fromEntries((clientes || []).map(c => [c.id, c.nombre]));
  const anioActual = new Date().getFullYear();
  const fpPorProyecto = {};
  (facturaProyectos || []).forEach(fp => {
    if (!fp.facturas || fp.facturas.tipo !== "factura") return;
    (fpPorProyecto[fp.proyecto_id] ||= []).push(fp);
  });

  // Construimos una fila por (proyecto, factura vinculada); si un proyecto no
  // tiene ninguna factura vinculada, se muestra igualmente con una sola fila
  // "sin factura" para poder generarla desde aquí.
  const filas = [];
  (proyectos || []).forEach(p => {
    const vinculos = fpPorProyecto[p.id];
    const fechaRef = p.fecha_entrega || p.fecha_inicio || null;
    if (vinculos && vinculos.length) {
      vinculos.forEach(v => {
        const fecha = v.facturas.fecha || fechaRef;
        filas.push({ proyecto: p, fecha, importe: Number(v.importe || 0), facturaNumero: v.facturas.numero, facturaEstado: v.facturas.estado, facturaId: v.factura_id });
      });
    } else {
      filas.push({ proyecto: p, fecha: fechaRef, importe: Number(p.precio_acordado || 0), facturaNumero: null, facturaEstado: null, facturaId: null });
    }
  });

  const anios = Array.from(new Set([...filas.map(f => f.fecha ? new Date(f.fecha).getFullYear() : anioActual), anioActual])).sort((a,b)=>b-a);

  container.innerHTML = `
    <div style="display:flex; justify-content:space-between; margin-bottom:14px; gap:8px; align-items:center;">
      <h2 style="margin:0;">Facturación por mes</h2>
      <div style="display:flex; gap:8px; align-items:center;">
        <label style="margin:0;">Año</label>
        <select id="sel-anio" style="width:auto;">${anios.map(a => `<option value="${a}" ${a===anioActual?"selected":""}>${a}</option>`).join("")}</select>
      </div>
    </div>
    <div id="resumen-anual" class="grid grid-4" style="margin-bottom:20px;"></div>
    <div id="meses-body"></div>
  `;

  container.querySelector("#sel-anio").addEventListener("change", e => pintar(Number(e.target.value)));
  pintar(anioActual);

  function pintar(anio) {
    const filasAnio = filas.filter(f => f.fecha && new Date(f.fecha).getFullYear() === anio);

    const totalAnual = round2(filasAnio.reduce((s,f)=>s+f.importe,0));
    const totalTransferencia = round2(filasAnio.filter(f => (f.proyecto.forma_pago||"transferencia") === "transferencia").reduce((s,f)=>s+f.importe,0));
    const totalEfectivo = round2(filasAnio.filter(f => f.proyecto.forma_pago === "efectivo").reduce((s,f)=>s+f.importe,0));
    const totalMixto = round2(filasAnio.filter(f => f.proyecto.forma_pago === "mixto").reduce((s,f)=>s+f.importe,0));
    const totalGastos = round2(sumaGastosDeduciblesEnRango(gastos, `${anio}-01-01`, `${anio}-12-31`));

    container.querySelector("#resumen-anual").innerHTML = `
      <div class="card kpi"><div class="label">Total facturado ${anio}</div><div class="value">${eur(totalAnual)}</div></div>
      <div class="card kpi"><div class="label">Por transferencia</div><div class="value" style="color:${FORMAS_PAGO.transferencia.fg}">${eur(totalTransferencia)}</div></div>
      <div class="card kpi"><div class="label">En efectivo</div><div class="value" style="color:${FORMAS_PAGO.efectivo.fg}">${eur(totalEfectivo + totalMixto)}</div></div>
      <div class="card kpi dark"><div class="label">Gastos deducibles ${anio}</div><div class="value">${eur(totalGastos)}</div></div>
    `;

    const $body = container.querySelector("#meses-body");
    $body.innerHTML = MESES.map((nombreMes, idx) => {
      const filasMes = filasAnio.filter(f => new Date(f.fecha).getMonth() === idx)
        .sort((a,b) => (a.proyecto.nombre||"").localeCompare(b.proyecto.nombre||""));
      const totalMes = round2(filasMes.reduce((s,f)=>s+f.importe,0));
      if (!filasMes.length) {
        return `<details class="card" style="margin-bottom:10px;"><summary style="cursor:pointer; font-weight:600;">${nombreMes} — ${eur(0)}</summary><p class="muted" style="margin-top:10px;">Sin proyectos este mes.</p></details>`;
      }
      return `
      <details class="card" style="margin-bottom:10px;" ${idx === new Date().getMonth() && anio === anioActual ? "open" : ""}>
        <summary style="cursor:pointer; font-weight:600;">${nombreMes} — ${eur(totalMes)} <span class="muted" style="font-weight:400;">(${filasMes.length} proyecto${filasMes.length===1?"":"s"})</span></summary>
        <table style="margin-top:10px;">
          <thead><tr><th>Proyecto</th><th>Cliente</th><th>Nº factura</th><th>Importe</th><th>Forma de pago</th><th style="text-align:center;">Emitida</th><th style="text-align:center;">Pagada</th></tr></thead>
          <tbody>
            ${filasMes.map((f, i) => {
              const fp = FORMAS_PAGO[f.proyecto.forma_pago || "transferencia"];
              const emitida = !!f.facturaEstado && f.facturaEstado !== "borrador";
              const pagada = f.facturaEstado === "pagada";
              return `<tr data-row="${idx}-${i}">
                <td class="link-proyecto" data-proyecto-id="${f.proyecto.id}" style="cursor:pointer; color:var(--blue-fg, #3E6FE0);">${escapeHtml(f.proyecto.nombre)}</td>
                <td>${escapeHtml(clientesMap[f.proyecto.cliente_id] || "—")}</td>
                <td>${f.facturaNumero ? escapeHtml(f.facturaNumero) : `<button class="btn btn-ghost btn-generar-mini" data-proyecto-id="${f.proyecto.id}" style="font-size:11px; padding:2px 8px;">+ Generar</button>`}</td>
                <td>${eur(f.importe)}</td>
                <td><span class="badge" style="background:${fp.bg}; color:${fp.fg};">${fp.label}</span></td>
                <td style="text-align:center;"><input type="checkbox" class="chk-emitida" data-factura-id="${f.facturaId||""}" ${emitida?"checked":""} ${!f.facturaId?"disabled":""}></td>
                <td style="text-align:center;"><input type="checkbox" class="chk-pagada" data-factura-id="${f.facturaId||""}" ${pagada?"checked":""} ${!f.facturaId?"disabled":""}></td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </details>`;
    }).join("");

    $body.querySelectorAll(".link-proyecto").forEach(td => {
      td.addEventListener("click", () => { location.hash = `#/proyectos/${td.dataset.proyectoId}`; });
    });
    $body.querySelectorAll(".btn-generar-mini").forEach(btn => {
      btn.addEventListener("click", (e) => { e.stopPropagation(); location.hash = `#/facturacion/nuevo-desde-proyecto:${btn.dataset.proyectoId}`; });
    });
    $body.querySelectorAll(".chk-emitida").forEach(chk => {
      chk.addEventListener("click", async (e) => {
        e.preventDefault();
        const facturaId = chk.dataset.facturaId;
        if (!facturaId) return;
        const { data: f } = await db.from("facturas").select("estado").eq("id", facturaId).single().exec();
        if (!f) return;
        if (f.estado === "pagada") { alert("Esta factura ya está pagada. Cambia primero el estado de \"Pagada\" si quieres revertirla."); return; }
        const nuevoEstado = f.estado === "borrador" ? "emitida" : "borrador";
        await db.from("facturas").update({ estado: nuevoEstado }).eq("id", facturaId).exec();
        pintar(anio);
      });
    });
    $body.querySelectorAll(".chk-pagada").forEach(chk => {
      chk.addEventListener("click", async (e) => {
        e.preventDefault();
        const facturaId = chk.dataset.facturaId;
        if (!facturaId) return;
        const { data: f } = await db.from("facturas").select("estado").eq("id", facturaId).single().exec();
        if (!f) return;
        const nuevoEstado = f.estado === "pagada" ? "emitida" : "pagada";
        await db.from("facturas").update({ estado: nuevoEstado }).eq("id", facturaId).exec();
        pintar(anio);
      });
    });
  }
}
