import { db } from "../supabase.js";
import { eur, FORMAS_PAGO } from "../utils/format.js";
import { round2 } from "../utils/invoice-calc.js";
import { construirLedger, resumenPeriodo, rangoAnio, conIva, estadoEfectivo } from "../utils/resumen.js";
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
  const ledger = construirLedger(proyectos, facturaProyectos);

  const anios = Array.from(new Set([...ledger.map(f => f.fecha ? new Date(f.fecha).getFullYear() : anioActual), anioActual])).sort((a,b)=>b-a);

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
    const { desde, hasta } = rangoAnio(anio);
    const r = resumenPeriodo(ledger, gastos, desde, hasta);
    const filasAnio = r.filas;

    container.querySelector("#resumen-anual").innerHTML = `
      <div class="card kpi"><div class="label">Total facturado ${anio}</div><div class="value">${eur(r.totalBase)}</div><div class="muted" style="font-size:12px;">${eur(r.totalConIva)} con IVA</div></div>
      <div class="card kpi"><div class="label">Por transferencia</div><div class="value" style="color:${FORMAS_PAGO.transferencia.fg}">${eur(r.transferencia)}</div></div>
      <div class="card kpi"><div class="label">En efectivo</div><div class="value" style="color:${FORMAS_PAGO.efectivo.fg}">${eur(r.efectivo)}</div></div>
      <div class="card kpi dark"><div class="label">Gastos deducibles ${anio}</div><div class="value">${eur(r.gastosDeducibles)}</div></div>
    `;

    const $body = container.querySelector("#meses-body");
    $body.innerHTML = MESES.map((nombreMes, idx) => {
      const filasMes = filasAnio.filter(f => new Date(f.fecha).getMonth() === idx)
        .sort((a,b) => (a.proyecto.nombre||"").localeCompare(b.proyecto.nombre||""));
      const totalMes = round2(filasMes.reduce((s,f)=>s+f.importeBase,0));
      if (!filasMes.length) {
        return `<details class="card" style="margin-bottom:10px;"><summary style="cursor:pointer; font-weight:600;">${nombreMes} — ${eur(0)}</summary><p class="muted" style="margin-top:10px;">Sin proyectos este mes.</p></details>`;
      }
      return `
      <details class="card" style="margin-bottom:10px;" ${idx === new Date().getMonth() && anio === anioActual ? "open" : ""}>
        <summary style="cursor:pointer; font-weight:600;">${nombreMes} — ${eur(totalMes)} <span class="muted" style="font-weight:400;">(${filasMes.length} proyecto${filasMes.length===1?"":"s"})</span></summary>
        <table style="margin-top:10px;">
          <thead><tr><th>Proyecto</th><th>Cliente</th><th>Nº factura</th><th>Importe</th><th>Importe c/IVA</th><th>Forma de pago</th><th style="text-align:center;">Emitida</th><th style="text-align:center;">Pagada</th></tr></thead>
          <tbody>
            ${filasMes.map((f, i) => {
              const fp = FORMAS_PAGO[f.proyecto.forma_pago || "transferencia"];
              const estado = estadoEfectivo(f);
              const emitida = estado === "emitida" || estado === "pagada";
              const pagada = estado === "pagada";
              return `<tr data-row="${idx}-${i}">
                <td class="link-proyecto" data-proyecto-id="${f.proyecto.id}" style="cursor:pointer; color:var(--blue);">${escapeHtml(f.proyecto.nombre)}</td>
                <td>${escapeHtml(clientesMap[f.proyecto.cliente_id] || "—")}</td>
                <td>${f.facturaNumero ? escapeHtml(f.facturaNumero) : `<button class="btn btn-ghost btn-generar-mini" data-proyecto-id="${f.proyecto.id}" style="font-size:11px; padding:2px 8px;">+ Generar</button>`}</td>
                <td>${eur(f.importeBase)}</td>
                <td class="muted">${eur(conIva(f.importeBase))}</td>
                <td><span class="badge" style="background:${fp.bg}; color:${fp.fg};">${fp.label}</span></td>
                <td style="text-align:center;"><input type="checkbox" class="chk-emitida" data-proyecto-id="${f.proyecto.id}" data-factura-id="${f.facturaId||""}" ${emitida?"checked":""}></td>
                <td style="text-align:center;"><input type="checkbox" class="chk-pagada" data-proyecto-id="${f.proyecto.id}" data-factura-id="${f.facturaId||""}" ${pagada?"checked":""}></td>
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

    async function setEstadoProyecto(proyectoId, nuevoEstado) {
      await db.from("proyectos").update({ estado_facturacion: nuevoEstado }).eq("id", proyectoId).exec();
      const p = (proyectos || []).find(x => x.id === proyectoId);
      if (p) p.estado_facturacion = nuevoEstado;
      pintar(anio);
    }
    async function setEstadoFactura(facturaId, nuevoEstado) {
      await db.from("facturas").update({ estado: nuevoEstado }).eq("id", facturaId).exec();
      (facturaProyectos || []).forEach(fp => { if (fp.factura_id === facturaId && fp.facturas) fp.facturas.estado = nuevoEstado; });
      pintar(anio);
    }

    $body.querySelectorAll(".chk-emitida").forEach(chk => {
      chk.addEventListener("click", async (e) => {
        e.preventDefault();
        const facturaId = chk.dataset.facturaId;
        if (facturaId) {
          const { data: f } = await db.from("facturas").select("estado").eq("id", facturaId).single().exec();
          if (!f) return;
          if (f.estado === "pagada") { alert("Esta factura ya está pagada. Cambia primero \"Pagada\" si quieres revertirla."); return; }
          await setEstadoFactura(facturaId, f.estado === "borrador" ? "emitida" : "borrador");
        } else {
          const proyectoId = chk.dataset.proyectoId;
          const p = (proyectos || []).find(x => x.id === proyectoId);
          if (p && p.estado_facturacion === "pagada") { alert("Este proyecto ya está marcado como pagado. Cambia primero \"Pagada\" si quieres revertirlo."); return; }
          await setEstadoProyecto(proyectoId, (p?.estado_facturacion || "pendiente") === "pendiente" ? "emitida" : "pendiente");
        }
      });
    });
    $body.querySelectorAll(".chk-pagada").forEach(chk => {
      chk.addEventListener("click", async (e) => {
        e.preventDefault();
        const facturaId = chk.dataset.facturaId;
        if (facturaId) {
          const { data: f } = await db.from("facturas").select("estado").eq("id", facturaId).single().exec();
          if (!f) return;
          await setEstadoFactura(facturaId, f.estado === "pagada" ? "emitida" : "pagada");
        } else {
          const proyectoId = chk.dataset.proyectoId;
          const p = (proyectos || []).find(x => x.id === proyectoId);
          const actual = p?.estado_facturacion || "pendiente";
          await setEstadoProyecto(proyectoId, actual === "pagada" ? "emitida" : "pagada");
        }
      });
    });
  }
}
