import { db } from "../supabase.js";
import { eur } from "../utils/format.js";
import { calcularModelo130, round2, PLAZOS_MODELO_130_2026 } from "../utils/invoice-calc.js";
import { construirLedger, resumenPeriodo, resumenTrimestre, rangoMes, rangoAnio } from "../utils/resumen.js";

const MESES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
let chartMensual = null;

// "Gastos de difícil justificación": deducción a tanto alzado del 5% sobre
// (ingresos - gastos deducibles) en estimación directa simplificada, con un
// tope de 2.000€ acumulados por año natural. No es un gasto que se registre
// con ticket: la calcula automáticamente Hacienda (y tu gestoría) sobre el
// rendimiento del periodo. La aplicamos aquí para que el rendimiento neto que
// ve Josep coincida con el de su asesor.
const TOPE_DIFICIL_JUSTIFICACION_ANUAL = 2000;
function gastoDificilJustificacion(ingresos, gastosDeducibles, acumuladoAnioPrevio) {
  const baseAntes = round2(Math.max(ingresos - gastosDeducibles, 0));
  const bruto = round2(baseAntes * 0.05);
  const disponible = round2(Math.max(TOPE_DIFICIL_JUSTIFICACION_ANUAL - acumuladoAnioPrevio, 0));
  return round2(Math.min(bruto, disponible));
}

// Registro local (este dispositivo) de qué trimestres ya se han presentado /
// pagado en Hacienda — así el Modelo 130 deja de ser solo una cifra y pasa a
// ser una checklist con la que de verdad puedes marcar tu progreso.
const LS_KEY = "jml_modelo130_presentado";
function leerPresentados() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { return {}; }
}
function marcarPresentado(anio, q, valor) {
  const datos = leerPresentados();
  const key = `${anio}-T${q}`;
  if (valor) datos[key] = true; else delete datos[key];
  localStorage.setItem(LS_KEY, JSON.stringify(datos));
}

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

    // --- Trimestral (Modelo 130) --- Solo lo ya cobrado (pagada), según lo pedido.
    let acumuladoPagado = 0;
    let acumuladoDificilJustificacion = 0;
    const presentados = leerPresentados();
    const trimestres = [1,2,3,4].map(q => {
      const t = resumenTrimestre(ledger, facturas, gastos, anio, q);
      const dificilJustificacion = gastoDificilJustificacion(t.transferenciaPagada, t.gastosDeducibles, acumuladoDificilJustificacion);
      acumuladoDificilJustificacion = round2(acumuladoDificilJustificacion + dificilJustificacion);
      const gastosConDificilJustificacion = round2(t.gastosDeducibles + dificilJustificacion);
      const r = calcularModelo130({ ingresosBaseTrimestre: t.transferenciaPagada, gastosTrimestre: gastosConDificilJustificacion, retencionesSoportadasTrimestre: t.retenciones, pagosPreviosAnio: acumuladoPagado });
      acumuladoPagado += r.aIngresar;
      const plazo = PLAZOS_MODELO_130_2026[q-1];
      const presentado = !!presentados[`${anio}-T${q}`];
      return { q, ...t, dificilJustificacion, gastosConDificilJustificacion, ...r, plazo, presentado };
    });

    const hoy = new Date();
    const trimestreActual = Math.floor(hoy.getMonth()/3) + 1;
    const proximoTrimestre = trimestres[trimestreActual - 1] || trimestres[0];
    const plazoProximoVencido = new Date(proximoTrimestre.plazo.fin) < hoy;

    container.querySelector("#financiero-body").innerHTML = `
      <div class="grid grid-4" style="margin-bottom:20px;">
        <div class="card kpi"><div class="label">Cobrado por transferencia ${anio}</div><div class="value">${eur(anual.transferenciaPagada)}</div><div class="muted" style="font-size:11px;">${eur(anual.transferenciaNoPagada)} facturado y aún sin cobrar</div></div>
        <div class="card kpi"><div class="label">Gastos deducibles ${anio}</div><div class="value">${eur(anual.gastosDeducibles)}</div><div class="muted" style="font-size:11px;">+ ${eur(acumuladoDificilJustificacion)} difícil justificación</div></div>
        <div class="card kpi"><div class="label">Beneficio fiscal neto (cobrado)</div><div class="value" style="color:var(--green-fg)">${eur(anual.beneficioFiscalPagado)}</div></div>
        <div class="card kpi dark" style="${plazoProximoVencido && !proximoTrimestre.presentado ? "outline:2px solid #E8985B;" : ""}">
          <div class="label">${proximoTrimestre.presentado ? "Modelo 130 (T"+trimestreActual+")" : "Pendiente de presentar — T"+trimestreActual}</div>
          <div class="value">${eur(proximoTrimestre.aIngresar)}</div>
          <div style="font-size:11px;color:${plazoProximoVencido && !proximoTrimestre.presentado ? "#F5B896" : "#8FD6B3"};">
            ${proximoTrimestre.presentado ? "Marcado como presentado ✓" : (plazoProximoVencido ? "Plazo vencido el " + proximoTrimestre.plazo.fin : "Vence " + proximoTrimestre.plazo.fin)}
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:20px;">
        <h3>Facturación mensual ${anio} <span class="muted" style="font-weight:400; font-size:12px;">(transferencia · efectivo · aún sin cobrar)</span></h3>
        <div style="position:relative; height:220px;"><canvas id="chart-mensual"></canvas></div>
      </div>

      <div class="card" style="margin-bottom:20px; border-left:4px solid var(--blue);">
        <h3 style="margin-bottom:2px;">Modelo 130 — pago fraccionado trimestral</h3>
        <p class="muted" style="font-size:12px; margin-top:0;">Solo cuenta lo ya cobrado por transferencia (marcado como "pagada" en Facturación mensual), tus gastos deducibles y la deducción automática por "difícil justificación" (5%, tope 2.000€/año) que también aplica tu gestoría. Marca cada trimestre cuando lo presentes en la Sede de Hacienda, para llevar el control aquí mismo.</p>
        <table>
          <thead><tr><th>Trimestre</th><th>Cobrado (transferencia)</th><th>Gastos deducibles</th><th>Difícil justif.</th><th>Rendimiento neto</th><th>A ingresar</th><th>Plazo</th><th style="text-align:center;">Presentado</th></tr></thead>
          <tbody>
            ${trimestres.map(t => `<tr>
              <td>T${t.q}</td><td>${eur(t.transferenciaPagada)}</td><td>${eur(t.gastosDeducibles)}</td><td class="muted">+${eur(t.dificilJustificacion)}</td><td>${eur(t.rendimientoNeto)}</td>
              <td><strong>${eur(t.aIngresar)}</strong></td><td>${t.plazo.inicio.slice(8,10)}–${t.plazo.fin.slice(8,10)} ${t.plazo.fin.slice(5,7)}/${t.plazo.fin.slice(0,4)}</td>
              <td style="text-align:center;"><input type="checkbox" class="chk-presentado" data-q="${t.q}" ${t.presentado?"checked":""}></td>
            </tr>`).join("")}
            <tr style="font-weight:600; background:var(--light);">
              <td>Total ${anio}</td><td>${eur(anual.transferenciaPagada)}</td><td>${eur(anual.gastosDeducibles)}</td><td>+${eur(acumuladoDificilJustificacion)}</td><td colspan="1"></td><td>${eur(trimestres.reduce((s,t)=>s+t.aIngresar,0))}</td><td colspan="2"></td>
            </tr>
          </tbody>
        </table>
        <p class="muted" style="font-size:12px; margin-top:10px;">Estimación orientativa (20% del rendimiento neto acumulado, menos retenciones e ingresos previos del año). Confírmalo con tu gestor/a antes de presentar el modelo oficial. "Presentado" solo se guarda en este dispositivo, a modo de recordatorio.</p>
      </div>

      <div class="card" style="border-left:4px solid var(--purple-fg, #6B3FA0);">
        <h3 style="margin-bottom:2px;">Balance real (personal)</h3>
        <p class="muted" style="font-size:12px; margin-top:0;">Incluye también el efectivo y los gastos no deducibles — es lo que de verdad ha entrado y salido de tu bolsillo (solo cobros ya marcados como pagados).</p>
        <table>
          <thead><tr><th></th><th>Transferencia</th><th>Efectivo</th><th>Total</th></tr></thead>
          <tbody>
            <tr><td>Cobrado</td><td>${eur(anual.transferenciaPagada)}</td><td>${eur(anual.efectivoPagada)}</td><td><strong>${eur(round2(anual.transferenciaPagada + anual.efectivoPagada))}</strong></td></tr>
            <tr><td>Aún sin cobrar</td><td>${eur(anual.transferenciaNoPagada)}</td><td>${eur(anual.efectivoNoPagada)}</td><td class="muted">${eur(anual.noPagado)}</td></tr>
            <tr><td>Gastos</td><td colspan="2" class="muted">deducibles ${eur(anual.gastosDeducibles)} + no deducibles ${eur(anual.gastosNoDeducibles)}</td><td><strong>${eur(anual.gastosTotales)}</strong></td></tr>
            <tr style="font-weight:600; background:var(--light);"><td>Beneficio real (cobrado)</td><td colspan="2"></td><td style="color:var(--green-fg)">${eur(anual.beneficioRealPagado)}</td></tr>
          </tbody>
        </table>
      </div>
    `;

    container.querySelectorAll(".chk-presentado").forEach(chk => {
      chk.addEventListener("change", () => {
        marcarPresentado(anio, Number(chk.dataset.q), chk.checked);
        pintar(anio);
      });
    });

    const ctx = container.querySelector("#chart-mensual");
    if (ctx && window.Chart) {
      if (chartMensual) { chartMensual.destroy(); chartMensual = null; }
      chartMensual = new window.Chart(ctx, {
        type: "bar",
        data: {
          labels: MESES,
          datasets: [
            { label: "Transferencia (cobrado)", data: porMes.map(m=>m.transferenciaPagada), backgroundColor: "#3E6FE0", stack: "s" },
            { label: "Efectivo (cobrado)", data: porMes.map(m=>m.efectivoPagada), backgroundColor: "#F2B84B", stack: "s" },
            { label: "Aún sin cobrar", data: porMes.map(m=>m.noPagado), backgroundColor: "#C6CCE0", stack: "s" },
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
