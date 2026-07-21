import { db } from "../supabase.js";
import { eur } from "../utils/format.js";
import { calcularModelo130, round2, PLAZOS_MODELO_130_2026 } from "../utils/invoice-calc.js";
import { construirLedger, resumenPeriodo, resumenTrimestre, rangoMes, rangoAnio } from "../utils/resumen.js";

const MESES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
let chartMensual = null;

export async function renderFinanciero(container) {
  container.innerHTML = `<div class="empty-state">Cargando datos financieros…</div>`;

  const [{ data: proyectos, error: e1 }, { data: facturaProyectos, error: e2 }, { data: facturas, error: e3 }, { data: gastos, error: e4 }] = await Promise.all([
    db.from("proyectos").select("*").exec(),
    db.from("factura_proyectos").select("importe,factura_id,proyecto_id,facturas(numero,estado,fecha,tipo)").exec(),
    db.from("facturas").select("*").exec(),
    db.from("gastos").select("*").exec(),
  ]);
  if (e1 || e2 || e3 || e4) { container.innerHTML = `<p class="muted">Error cargando datos: ${e1||e2||e3||e4}</p>`; return; }

  const ledger = construirLedger(proyectos, facturaProyectos);
  const anioActual = new Date().getFullYear();
  const anios = Array.from(new Set([...ledger.map(f=>f.fecha ? new Date(f.fecha).getFullYear() : anioActual), anioActual])).sort();

  container.innerHTML = `
    <div style="display:flex; justify-content:space-between; margin-bottom:14px; gap:8px; align-items:center;">
      <a href="#/gastos" class="btn btn-ghost">Ir al módulo de Gastos →</a>
      <div style="display:flex; gap:8px; align-items:center;">
        <label style="margin:0;">Año</label>
        <select id="sel-anio" style="width:auto;">${anios.map(a => `<option value="${a}" ${a===anioActual?"selected":""}>${a}</option>`).join("")}</select>
      </div>
    </div>
    <div id="financiero-body"></div>`;

  container.querySelector("#sel-anio").addEventListener("change", e => pintar(Number(e.target.value)));
  pintar(anioActual);

  function pintar(anio) {
    const { desde, hasta } = rangoAnio(anio);
    const anual = resumenPeriodo(ledger, gastos, desde, hasta);

    // --- Mensual (para la gráfica) ---
    const porMes = MESES.map((_, i) => {
      const r = rangoMes(anio, i);
      return resumenPeriodo(ledger, gastos, r.desde, r.hasta);
    });

    // --- Trimestral (Modelo 130) ---
    let acumuladoPagado = 0;
    const trimestres = [1,2,3,4].map(q => {
      const t = resumenTrimestre(ledger, facturas, gastos, anio, q);
      const r = calcularModelo130({ ingresosBaseTrimestre: t.transferencia, gastosTrimestre: t.gastosDeducibles, retencionesSoportadasTrimestre: t.retenciones, pagosPreviosAnio: acumuladoPagado });
      acumuladoPagado += r.aIngresar;
      const plazo = PLAZOS_MODELO_130_2026[q-1];
      return { q, ...t, ...r, plazo };
    });

    const hoy = new Date();
    const trimestreActual = Math.floor(hoy.getMonth()/3) + 1;
    const proximoTrimestre = trimestres[trimestreActual - 1] || trimestres[0];

    container.querySelector("#financiero-body").innerHTML = `
      <div class="grid grid-4" style="margin-bottom:20px;">
        <div class="card kpi"><div class="label">Facturado (transferencia) ${anio}</div><div class="value">${eur(anual.transferencia)}</div></div>
        <div class="card kpi"><div class="label">Gastos deducibles ${anio}</div><div class="value">${eur(anual.gastosDeducibles)}</div></div>
        <div class="card kpi"><div class="label">Beneficio fiscal neto</div><div class="value" style="color:var(--green-fg)">${eur(anual.beneficioFiscal)}</div></div>
        <div class="card kpi dark"><div class="label">Próx. pago Modelo 130 (T${trimestreActual})</div><div class="value">${eur(proximoTrimestre.aIngresar)}</div><div style="font-size:11px;color:#8FD6B3;">Vence ${proximoTrimestre.plazo.fin}</div></div>
      </div>

      <div class="card" style="margin-bottom:20px;">
        <h3>Facturación mensual ${anio} <span class="muted" style="font-weight:400; font-size:12px;">(transferencia vs. efectivo)</span></h3>
        <div style="position:relative; height:220px;"><canvas id="chart-mensual"></canvas></div>
      </div>

      <div class="card" style="margin-bottom:20px; border-left:4px solid var(--blue);">
        <h3 style="margin-bottom:2px;">Balance fiscal (Hacienda)</h3>
        <p class="muted" style="font-size:12px; margin-top:0;">Solo cuenta lo cobrado por transferencia (declarable) y los gastos deducibles. Es la base de tu IRPF / Modelo 130.</p>
        <table>
          <thead><tr><th>Trimestre</th><th>Ingresos (transferencia)</th><th>Gastos deducibles</th><th>Rendimiento neto</th><th>Pago fraccionado (20%)</th><th>A ingresar</th><th>Plazo</th></tr></thead>
          <tbody>
            ${trimestres.map(t => `<tr>
              <td>T${t.q}</td><td>${eur(t.transferencia)}</td><td>${eur(t.gastosDeducibles)}</td><td>${eur(t.rendimientoNeto)}</td><td>${eur(t.pagoBruto)}</td>
              <td><strong>${eur(t.aIngresar)}</strong></td><td>${t.plazo.inicio.slice(8,10)}–${t.plazo.fin.slice(8,10)} ${t.plazo.fin.slice(5,7)}/${t.plazo.fin.slice(0,4)}</td>
            </tr>`).join("")}
            <tr style="font-weight:600; background:var(--light);">
              <td>Total ${anio}</td><td>${eur(anual.transferencia)}</td><td>${eur(anual.gastosDeducibles)}</td><td colspan="2"></td><td>${eur(trimestres.reduce((s,t)=>s+t.aIngresar,0))}</td><td></td>
            </tr>
          </tbody>
        </table>
        <p class="muted" style="font-size:12px; margin-top:10px;">Estimación orientativa (20% del rendimiento neto acumulado, menos retenciones e ingresos previos del año). Confírmalo con tu gestor/a antes de presentar el modelo oficial.</p>
      </div>

      <div class="card" style="border-left:4px solid var(--purple-fg, #6B3FA0);">
        <h3 style="margin-bottom:2px;">Balance real (personal)</h3>
        <p class="muted" style="font-size:12px; margin-top:0;">Incluye también el efectivo y los gastos no deducibles — es lo que de verdad entra y sale de tu bolsillo.</p>
        <table>
          <thead><tr><th></th><th>Transferencia</th><th>Efectivo</th><th>Total</th></tr></thead>
          <tbody>
            <tr><td>Ingresos</td><td>${eur(anual.transferencia)}</td><td>${eur(anual.efectivo)}</td><td><strong>${eur(anual.totalBase)}</strong></td></tr>
            <tr><td>Gastos</td><td colspan="2" class="muted">deducibles ${eur(anual.gastosDeducibles)} + no deducibles ${eur(anual.gastosNoDeducibles)}</td><td><strong>${eur(anual.gastosTotales)}</strong></td></tr>
            <tr style="font-weight:600; background:var(--light);"><td>Beneficio real</td><td colspan="2"></td><td style="color:var(--green-fg)">${eur(anual.beneficioReal)}</td></tr>
          </tbody>
        </table>
      </div>
    `;

    const ctx = container.querySelector("#chart-mensual");
    if (ctx && window.Chart) {
      if (chartMensual) { chartMensual.destroy(); chartMensual = null; }
      chartMensual = new window.Chart(ctx, {
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
  }
}
