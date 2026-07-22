import { db } from "../supabase.js";
import { eur, ESTADOS_PROYECTO } from "../utils/format.js";
import { calcularModelo130 } from "../utils/invoice-calc.js";
import { construirLedger, resumenPeriodo, resumenTrimestre, rangoMes, rangoAnio, conIva, estadoEfectivo } from "../utils/resumen.js";
import { escapeHtml } from "./clientes.js";

const MESES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
let chartMensualDash = null;
let chartEstados = null;

export async function renderDashboard(container) {
  const [{ data: proyectos, error: e1 }, { data: facturaProyectos, error: e2 }, { data: facturas, error: e3 }, { data: gastos, error: e4 }, { data: clientes }] = await Promise.all([
    db.from("proyectos").select("*").exec(),
    db.from("factura_proyectos").select("importe,factura_id,proyecto_id,facturas(numero,estado,fecha,tipo)").exec(),
    db.from("facturas").select("*").exec(),
    db.from("gastos").select("*").exec(),
    db.from("clientes").select("id,nombre").exec(),
  ]);
  if (e1 || e2 || e3 || e4) { container.innerHTML = `<p class="muted">Error cargando el dashboard: ${e1||e2||e3||e4}</p>`; return; }

  const clientesMap = Object.fromEntries((clientes||[]).map(c=>[c.id,c.nombre]));
  const ledger = construirLedger(proyectos, facturaProyectos);
  const hoy = new Date();
  const anio = hoy.getFullYear();
  const qActual = Math.floor(hoy.getMonth()/3) + 1;

  const rMes = rangoMes(anio, hoy.getMonth());
  const resumenMes = resumenPeriodo(ledger, gastos, rMes.desde, rMes.hasta);
  const rAnio = rangoAnio(anio);
  const resumenAnual = resumenPeriodo(ledger, gastos, rAnio.desde, rAnio.hasta);

  const porMes = MESES.map((_, i) => resumenPeriodo(ledger, gastos, rangoMes(anio,i).desde, rangoMes(anio,i).hasta));

  // Provisión Modelo 130 del trimestre en curso
  let acumulado = 0;
  for (let q = 1; q < qActual; q++) {
    const t = resumenTrimestre(ledger, facturas, gastos, anio, q);
    const r = calcularModelo130({ ingresosBaseTrimestre: t.transferencia, gastosTrimestre: t.gastosDeducibles, retencionesSoportadasTrimestre: t.retenciones, pagosPreviosAnio: acumulado });
    acumulado += r.aIngresar;
  }
  const tActual = resumenTrimestre(ledger, facturas, gastos, anio, qActual);
  const provision = calcularModelo130({ ingresosBaseTrimestre: tActual.transferencia, gastosTrimestre: tActual.gastosDeducibles, retencionesSoportadasTrimestre: tActual.retenciones, pagosPreviosAnio: acumulado });

  // Pendiente de cobro: cualquier fila no marcada como pagada (con IVA, que es lo que se cobra)
  const pendientes = ledger.filter(f => estadoEfectivo(f) !== "pagada");
  const pendienteTotal = pendientes.reduce((s,f)=>s+conIva(f.importeBase),0);

  const enCurso = (proyectos||[]).filter(p => p.estado !== "cobrado").slice(0, 6);
  // "Proyectos por estado" se basa en el estado de cobro real (ledger), no en
  // el campo kanban `proyectos.estado`, que no refleja si ya se ha cobrado.
  const ESTADOS_COBRO = {
    pendiente: { label: "Sin facturar", fg: "#5B6478" },
    emitida:   { label: "Facturado, sin cobrar", fg: "#8A6A10" },
    pagada:    { label: "Cobrado", fg: "#2E7D53" },
  };
  const porEstado = Object.keys(ESTADOS_COBRO).map(k => ({ key: k, label: ESTADOS_COBRO[k].label, count: ledger.filter(f=>estadoEfectivo(f)===k).length }));

  container.innerHTML = `
    <div class="grid grid-4" style="margin-bottom:20px;">
      <div class="card kpi"><div class="label">Facturado este mes</div><div class="value">${eur(resumenMes.transferencia + resumenMes.efectivo)}</div></div>
      <div class="card kpi"><div class="label">Pendiente de cobro</div><div class="value">${eur(pendienteTotal)}</div><div class="muted" style="font-size:12px;">${pendientes.length} proyecto(s) emitido(s)</div></div>
      <div class="card kpi"><div class="label">Beneficio fiscal (año)</div><div class="value" style="color:var(--green-fg)">${eur(resumenAnual.beneficioFiscal)}</div></div>
      <div class="card kpi dark"><div class="label">Provisión Modelo 130 (T${qActual})</div><div class="value">${eur(provision.aIngresar)}</div></div>
    </div>

    <div class="grid grid-2" style="margin-bottom:20px;">
      <div class="card">
        <h3>Facturación ${anio} <span class="muted" style="font-weight:400; font-size:12px;">(transferencia vs. efectivo)</span></h3>
        <div style="position:relative; height:200px;"><canvas id="chart-dash-mensual"></canvas></div>
      </div>
      <div class="card">
        <h3>Proyectos por estado</h3>
        <div style="position:relative; height:200px;"><canvas id="chart-dash-estados"></canvas></div>
      </div>
    </div>

    <div class="grid grid-2" style="margin-bottom:20px;">
      <div class="card">
        <h3>Pendiente de cobro</h3>
        <table>
          <thead><tr><th>Proyecto</th><th>Cliente</th><th>Importe c/IVA</th></tr></thead>
          <tbody>${pendientes.slice(0,8).map(f => `<tr><td>${escapeHtml(f.proyecto.nombre)}</td><td>${escapeHtml(clientesMap[f.proyecto.cliente_id]||"—")}</td><td>${eur(conIva(f.importeBase))}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">Nada pendiente 🎉</td></tr>`}</tbody>
        </table>
        ${pendientes.length ? `<p style="margin-top:10px;"><a href="#/mensual">Ver y marcar como pagadas →</a></p>` : ""}
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

  const ctxMes = container.querySelector("#chart-dash-mensual");
  if (ctxMes && window.Chart) {
    if (chartMensualDash) { chartMensualDash.destroy(); chartMensualDash = null; }
    chartMensualDash = new window.Chart(ctxMes, {
      type: "bar",
      data: {
        labels: MESES,
        datasets: [
          { label: "Transferencia", data: porMes.map(m=>m.transferencia), backgroundColor: "#3E6FE0", stack: "s" },
          { label: "Efectivo", data: porMes.map(m=>m.efectivo), backgroundColor: "#F2B84B", stack: "s" },
        ],
      },
      options: {
        maintainAspectRatio: false,
        scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { callback: v => eur(v) } } },
        plugins: { legend: { position: "bottom" } },
      },
    });
  }

  const ctxEst = container.querySelector("#chart-dash-estados");
  if (ctxEst && window.Chart) {
    if (chartEstados) { chartEstados.destroy(); chartEstados = null; }
    const conDatos = porEstado.filter(e => e.count > 0);
    chartEstados = new window.Chart(ctxEst, {
      type: "doughnut",
      data: {
        labels: conDatos.map(e=>e.label),
        datasets: [{ data: conDatos.map(e=>e.count), backgroundColor: conDatos.map(e=>e.fg), borderWidth: 0 }],
      },
      options: { maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } } } },
    });
  }
}
