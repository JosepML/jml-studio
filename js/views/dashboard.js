import { db } from "../supabase.js";
import { eur, dateEs, quarterOf, ESTADOS_PROYECTO, ESTADOS_FACTURA } from "../utils/format.js";
import { calcularModelo130, round2 } from "../utils/invoice-calc.js";
import { escapeHtml } from "./clientes.js";

export async function renderDashboard(container) {
  const [{ data: facturas, error: e1 }, { data: gastos, error: e2 }, { data: proyectos, error: e3 }, { data: clientes }] = await Promise.all([
    db.from("facturas").select("*").exec(),
    db.from("gastos").select("*").exec(),
    db.from("proyectos").select("*").exec(),
    db.from("clientes").select("id,nombre").exec(),
  ]);
  if (e1 || e2 || e3) { container.innerHTML = `<p class="muted">Error cargando el dashboard: ${e1||e2||e3}</p>`; return; }

  const clientesMap = Object.fromEntries((clientes||[]).map(c=>[c.id,c.nombre]));
  const hoy = new Date();
  const anio = hoy.getFullYear();
  const mes = hoy.getMonth();

  const facturasAnio = (facturas||[]).filter(f => new Date(f.fecha).getFullYear() === anio && f.tipo === "factura");
  const facturadoMes = round2(facturasAnio.filter(f => new Date(f.fecha).getMonth() === mes).reduce((s,f)=>s+Number(f.total||0),0));
  const gastosAnio = (gastos||[]).filter(g => new Date(g.fecha).getFullYear() === anio);
  const totalBaseAnio = round2(facturasAnio.reduce((s,f)=>s+Number(f.base_imponible||0),0));
  const totalGastosAnio = round2(gastosAnio.reduce((s,g)=>s+Number(g.importe||0),0));
  const beneficioYtd = round2(totalBaseAnio - totalGastosAnio);

  const pendientes = (facturas||[]).filter(f => f.tipo === "factura" && (f.estado === "emitida" || f.estado === "vencida"));
  const pendienteTotal = round2(pendientes.reduce((s,f)=>s+Number(f.total||0),0));

  // Provisión Modelo 130 del trimestre en curso
  const qActual = quarterOf(hoy.toISOString().slice(0,10));
  let acumulado = 0;
  for (let q = 1; q < qActual; q++) {
    const facQ = facturasAnio.filter(f => quarterOf(f.fecha) === q);
    const gasQ = gastosAnio.filter(g => quarterOf(g.fecha) === q);
    const r = calcularModelo130({
      ingresosBaseTrimestre: round2(facQ.reduce((s,f)=>s+Number(f.base_imponible||0),0)),
      gastosTrimestre: round2(gasQ.reduce((s,g)=>s+Number(g.importe||0),0)),
      retencionesSoportadasTrimestre: round2(facQ.reduce((s,f)=>s+Number(f.retencion_importe||0),0)),
      pagosPreviosAnio: acumulado,
    });
    acumulado += r.aIngresar;
  }
  const facQActual = facturasAnio.filter(f => quarterOf(f.fecha) === qActual);
  const gasQActual = gastosAnio.filter(g => quarterOf(g.fecha) === qActual);
  const provision = calcularModelo130({
    ingresosBaseTrimestre: round2(facQActual.reduce((s,f)=>s+Number(f.base_imponible||0),0)),
    gastosTrimestre: round2(gasQActual.reduce((s,g)=>s+Number(g.importe||0),0)),
    retencionesSoportadasTrimestre: round2(facQActual.reduce((s,f)=>s+Number(f.retencion_importe||0),0)),
    pagosPreviosAnio: acumulado,
  });

  const enCurso = (proyectos||[]).filter(p => p.estado !== "cobrado").slice(0, 6);

  container.innerHTML = `
    <div class="grid grid-4" style="margin-bottom:20px;">
      <div class="card kpi"><div class="label">Facturado este mes</div><div class="value">${eur(facturadoMes)}</div></div>
      <div class="card kpi"><div class="label">Pendiente de cobro</div><div class="value">${eur(pendienteTotal)}</div><div class="muted" style="font-size:12px;">${pendientes.length} factura(s)</div></div>
      <div class="card kpi"><div class="label">Beneficio neto (YTD)</div><div class="value" style="color:var(--green-fg)">${eur(beneficioYtd)}</div></div>
      <div class="card kpi dark"><div class="label">Provisión Modelo 130 (T${qActual})</div><div class="value">${eur(provision.aIngresar)}</div></div>
    </div>

    <div class="grid grid-2" style="margin-bottom:20px;">
      <div class="card">
        <h3>Facturas pendientes de cobro</h3>
        <table>
          <thead><tr><th>Cliente</th><th>Importe</th><th>Estado</th></tr></thead>
          <tbody>${pendientes.slice(0,8).map(f => `<tr><td>${escapeHtml(clientesMap[f.cliente_id]||"—")}</td><td>${eur(f.total)}</td><td><span class="badge" style="background:${ESTADOS_FACTURA[f.estado].bg};color:${ESTADOS_FACTURA[f.estado].fg}">${ESTADOS_FACTURA[f.estado].label}</span></td></tr>`).join("") || `<tr><td colspan="3" class="muted">Nada pendiente 🎉</td></tr>`}</tbody>
        </table>
      </div>
      <div class="card">
        <h3>Proyectos en curso</h3>
        ${enCurso.map(p => `<div style="padding:8px 0; border-bottom:1px solid #F0F1F4;">
          <strong>${escapeHtml(p.nombre)}</strong><br>
          <span class="muted">${escapeHtml(clientesMap[p.cliente_id]||"Sin cliente")}</span>
          <span class="badge" style="background:${ESTADOS_PROYECTO[p.estado].bg}; color:${ESTADOS_PROYECTO[p.estado].fg}; float:right;">${ESTADOS_PROYECTO[p.estado].label}</span>
        </div>`).join("") || `<p class="muted">No hay proyectos activos. <a href="#/proyectos">Crea uno</a>.</p>`}
      </div>
    </div>`;
}
