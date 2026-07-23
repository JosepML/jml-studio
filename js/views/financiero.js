import { db } from "../supabase.js";
import { eur, CATEGORIAS_SERVICIO, CATEGORIAS_GASTO } from "../utils/format.js";
import { calcularModelo130, gastoDeducibleEnRango, round2, PLAZOS_MODELO_130_2026 } from "../utils/invoice-calc.js";
import { construirLedger, resumenPeriodo, resumenTrimestre, rangoMes, rangoAnio } from "../utils/resumen.js";

const MESES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
let chartMensual = null;
let chartIngresosServicio = null;

// Agrupa el coste real de los gastos (prorrateando amortizaciones) por
// categoría, dentro de un rango de fechas — para el desglose de la cuenta de
// resultados. A diferencia de "gastosDeducibles", aquí SÍ se incluyen los no
// deducibles (son coste real del negocio aunque Hacienda no los compute).
function gastosPorCategoriaEnRango(gastos, desde, hasta) {
  const out = {};
  (gastos || []).forEach(g => {
    const k = g.categoria || "otros";
    const esDeducible = g.deducible !== false;
    const monto = esDeducible
      ? gastoDeducibleEnRango(g, desde, hasta)
      : ((g.fecha >= desde && g.fecha <= hasta) ? round2(Number(g.importe || 0)) : 0);
    if (monto) out[k] = round2((out[k] || 0) + monto);
  });
  return out;
}

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

    // --- Cuenta de resultados (P&L) — adaptada a un negocio autónomo: sin
    // sueldos/alquiler/impuesto de sociedades, con IRPF (Modelo 130) y las
    // categorías reales de ingreso (tipo de servicio) y gasto de Josep. ---
    const ingresosPorCategoria = {};
    anual.filas.forEach(f => {
      const k = f.proyecto?.categoria_servicio || "otros";
      ingresosPorCategoria[k] = round2((ingresosPorCategoria[k] || 0) + f.importeBase);
    });
    const gastosPorCategoria = gastosPorCategoriaEnRango(gastos, desde, hasta);
    const ingresosEntradas = Object.entries(ingresosPorCategoria).sort((a,b) => b[1]-a[1]);
    const gastosEntradas = Object.entries(gastosPorCategoria).sort((a,b) => b[1]-a[1]);
    const totalIngresosPL = round2(ingresosEntradas.reduce((s,[,v])=>s+v, 0));
    const totalGastosPL = round2(gastosEntradas.reduce((s,[,v])=>s+v, 0));
    const resultadoAntesImpuestos = round2(totalIngresosPL - totalGastosPL);
    const irpfEstimadoAcumulado = round2(acumuladoPagado);
    const beneficioNetoEstimado = round2(resultadoAntesImpuestos - irpfEstimadoAcumulado);
    const numProyectosPL = anual.filas.length;
    const margenPct = totalIngresosPL ? round2(resultadoAntesImpuestos / totalIngresosPL * 100) : 0;
    const ticketMedio = numProyectosPL ? round2(totalIngresosPL / numProyectosPL) : 0;
    const gastoMedioProyecto = numProyectosPL ? round2(totalGastosPL / numProyectosPL) : 0;

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

      <div class="grid" style="grid-template-columns:1.6fr 1fr; margin-bottom:20px; align-items:start;">
        <div class="card">
          <h3 style="margin-bottom:2px;">Cuenta de resultados</h3>
          <p class="muted" style="font-size:12px; margin-top:0;">Acumulado ${anio} · facturado (no solo cobrado), coste real de los gastos (con amortizaciones prorrateadas).</p>
          <table>
            <tbody>
              <tr style="background:var(--light);"><td colspan="2" style="font-weight:700;">Ingresos por servicio</td></tr>
              ${ingresosEntradas.length ? ingresosEntradas.map(([k,v]) => {
                const cat = CATEGORIAS_SERVICIO[k] || CATEGORIAS_SERVICIO.otros;
                return `<tr><td style="padding-left:24px;"><span class="badge" style="background:${cat.bg}; color:${cat.fg};">${cat.label}</span></td><td style="text-align:right;">${eur(v)}</td></tr>`;
              }).join("") : `<tr><td colspan="2" class="muted" style="padding-left:24px;">Sin ingresos en ${anio}.</td></tr>`}
              <tr style="font-weight:700; border-top:1px solid var(--border);"><td>Ingresos totales</td><td style="text-align:right;">${eur(totalIngresosPL)}</td></tr>

              <tr style="background:var(--light);"><td colspan="2" style="font-weight:700; padding-top:14px;">Gastos por categoría</td></tr>
              ${gastosEntradas.length ? gastosEntradas.map(([k,v]) => {
                const cat = CATEGORIAS_GASTO[k] || CATEGORIAS_GASTO.otros;
                return `<tr><td style="padding-left:24px;"><span class="badge" style="background:${cat.bg}; color:${cat.fg};">${cat.label}</span></td><td style="text-align:right; color:var(--red-fg,#B4453A);">−${eur(v)}</td></tr>`;
              }).join("") : `<tr><td colspan="2" class="muted" style="padding-left:24px;">Sin gastos en ${anio}.</td></tr>`}
              <tr style="font-weight:700; border-top:1px solid var(--border);"><td>Gastos totales</td><td style="text-align:right; color:var(--red-fg,#B4453A);">−${eur(totalGastosPL)}</td></tr>

              <tr style="font-weight:700; border-top:2px solid var(--border);"><td style="padding-top:10px;">Resultado antes de impuestos</td><td style="text-align:right; padding-top:10px;">${eur(resultadoAntesImpuestos)}</td></tr>
              <tr><td class="muted">IRPF estimado (Modelo 130 acumulado)</td><td style="text-align:right; color:var(--red-fg,#B4453A);">−${eur(irpfEstimadoAcumulado)}</td></tr>
              <tr style="font-weight:700; background:var(--light);"><td>Beneficio neto estimado</td><td style="text-align:right; color:var(--green-fg);">${eur(beneficioNetoEstimado)}</td></tr>
            </tbody>
          </table>
        </div>
        <div style="display:flex; flex-direction:column; gap:20px;">
          <div class="card">
            <h3>Ingresos por tipo de servicio</h3>
            <div style="position:relative; height:170px;"><canvas id="chart-ingresos-servicio"></canvas></div>
          </div>
          <div class="card">
            <h3>Ratios clave</h3>
            <table style="margin:0;">
              <tbody>
                <tr><td>Margen sobre ingresos</td><td style="text-align:right; font-weight:600;">${margenPct}%</td></tr>
                <tr><td>Proyectos facturados</td><td style="text-align:right; font-weight:600;">${numProyectosPL}</td></tr>
                <tr><td>Ticket medio por proyecto</td><td style="text-align:right; font-weight:600;">${eur(ticketMedio)}</td></tr>
                <tr><td>Gasto medio por proyecto</td><td style="text-align:right; font-weight:600;">${eur(gastoMedioProyecto)}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:20px;">
        <h3>Facturación mensual ${anio} <span class="muted" style="font-weight:400; font-size:12px;">(transferencia · efectivo · aún sin cobrar)</span></h3>
        <div style="position:relative; height:220px;"><canvas id="chart-mensual"></canvas></div>
      </div>

      <div class="card" style="margin-bottom:20px;">
        <h3 style="margin-bottom:2px;">Beneficio mes a mes ${anio}</h3>
        <p class="muted" style="font-size:12px; margin-top:0; margin-bottom:16px;">Facturado (base imponible) − gastos del mes = beneficio mensual.</p>
        <div class="grid grid-4">
          ${porMes.map((m, i) => {
            const beneficioMes = round2(m.totalBase - m.gastosTotales);
            const positivo = beneficioMes >= 0;
            const color = positivo ? "var(--green-fg)" : "var(--red-fg,#B4453A)";
            return `<div class="card" style="box-shadow:none; padding:14px; border-left:4px solid ${color};">
              <div style="font-weight:700; font-size:13px; margin-bottom:8px;">${MESES[i]} ${anio}</div>
              <div style="font-size:20px; font-weight:800; letter-spacing:-.02em; color:${color};">${eur(beneficioMes)}</div>
              <div class="muted" style="font-size:11px; margin-bottom:10px;">beneficio mensual</div>
              <div style="font-size:12px; display:flex; flex-direction:column; gap:4px; border-top:1px solid var(--border); padding-top:8px;">
                <div style="display:flex; justify-content:space-between;"><span class="muted">Facturado</span><span>${eur(m.totalBase)}</span></div>
                <div style="display:flex; justify-content:space-between;"><span class="muted">Gastos</span><span>−${eur(m.gastosTotales)}</span></div>
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>

      <div class="card" style="margin-bottom:20px;">
        <h3 style="margin-bottom:2px;">Modelo 130 — pago fraccionado trimestral</h3>
        <p class="muted" style="font-size:12px; margin-top:0; margin-bottom:16px;">Solo cuenta lo ya cobrado por transferencia (marcado como "pagada" en Facturación mensual), tus gastos deducibles y la deducción automática por "difícil justificación" (5%, tope 2.000€/año) que también aplica tu gestoría. Marca cada trimestre cuando lo presentes en la Sede de Hacienda, para llevar el control aquí mismo.</p>
        <div class="grid grid-4">
          ${trimestres.map(t => {
            const vencido = new Date(t.plazo.fin) < hoy;
            const borderColor = t.presentado ? "var(--green-fg)" : (vencido ? "var(--orange-fg)" : "var(--blue)");
            const badge = t.presentado
              ? `<span class="badge" style="background:var(--green-bg); color:var(--green-fg);">Presentado ✓</span>`
              : (vencido ? `<span class="badge" style="background:var(--orange-bg); color:var(--orange-fg);">Vencido</span>` : `<span class="badge" style="background:var(--grey-bg); color:var(--grey-fg);">Pendiente</span>`);
            return `<div class="card" style="box-shadow:none; padding:16px; border-left:4px solid ${borderColor};">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                <span style="font-weight:700; font-size:13px;">T${t.q} ${anio}</span>
                ${badge}
              </div>
              <div style="font-size:22px; font-weight:800; letter-spacing:-.02em;">${eur(t.aIngresar)}</div>
              <div class="muted" style="font-size:11px; margin-bottom:12px;">a ingresar · plazo ${t.plazo.inicio.slice(8,10)}–${t.plazo.fin.slice(8,10)}/${t.plazo.fin.slice(5,7)}</div>
              <div style="font-size:12px; display:flex; flex-direction:column; gap:4px; border-top:1px solid var(--border); padding-top:10px;">
                <div style="display:flex; justify-content:space-between;"><span class="muted">Cobrado</span><span>${eur(t.transferenciaPagada)}</span></div>
                <div style="display:flex; justify-content:space-between;"><span class="muted">Gastos deducibles</span><span>${eur(t.gastosDeducibles)}</span></div>
                <div style="display:flex; justify-content:space-between;"><span class="muted">Difícil justif.</span><span>+${eur(t.dificilJustificacion)}</span></div>
                <div style="display:flex; justify-content:space-between;"><span class="muted">Rendimiento neto</span><span>${eur(t.rendimientoNeto)}</span></div>
              </div>
              <label style="display:flex; align-items:center; gap:6px; margin-top:12px; font-size:12px; cursor:pointer;">
                <input type="checkbox" class="chk-presentado" data-q="${t.q}" ${t.presentado?"checked":""}> Marcar como presentado
              </label>
            </div>`;
          }).join("")}
        </div>
        <div class="muted" style="font-size:12px; margin-top:16px; display:flex; justify-content:space-between; flex-wrap:wrap; gap:6px; border-top:1px solid var(--border); padding-top:12px;">
          <span>Total ${anio}: cobrado ${eur(anual.transferenciaPagada)} · gastos deducibles ${eur(anual.gastosDeducibles)} (+${eur(acumuladoDificilJustificacion)} difícil justif.)</span>
          <strong style="color:var(--text);">A ingresar total: ${eur(trimestres.reduce((s,t)=>s+t.aIngresar,0))}</strong>
        </div>
        <p class="muted" style="font-size:12px; margin-top:10px;">Estimación orientativa (20% del rendimiento neto acumulado, menos retenciones e ingresos previos del año). Confírmalo con tu gestor/a antes de presentar el modelo oficial. "Presentado" solo se guarda en este dispositivo, a modo de recordatorio.</p>
      </div>

      <div class="card" style="border-left:4px solid var(--purple-fg, #6B3FA0);">
        <h3 style="margin-bottom:2px;">Balance real (personal)</h3>
        <p class="muted" style="font-size:12px; margin-top:0; margin-bottom:16px;">Incluye también el efectivo y los gastos no deducibles — es lo que de verdad ha entrado y salido de tu bolsillo (solo cobros ya marcados como pagados).</p>
        <div class="grid" style="grid-template-columns:repeat(3,1fr);">
          <div>
            <div class="muted" style="font-size:11px; text-transform:uppercase; letter-spacing:.06em; font-weight:700;">Cobrado</div>
            <div style="font-size:22px; font-weight:800; margin:6px 0 2px; letter-spacing:-.02em;">${eur(round2(anual.transferenciaPagada + anual.efectivoPagada))}</div>
            <div class="muted" style="font-size:11px;">Transferencia ${eur(anual.transferenciaPagada)} · Efectivo ${eur(anual.efectivoPagada)}</div>
            <div class="muted" style="font-size:11px; margin-top:2px;">+ ${eur(anual.noPagado)} aún sin cobrar</div>
          </div>
          <div>
            <div class="muted" style="font-size:11px; text-transform:uppercase; letter-spacing:.06em; font-weight:700;">Gastos</div>
            <div style="font-size:22px; font-weight:800; margin:6px 0 2px; letter-spacing:-.02em; color:var(--red-fg,#B4453A);">−${eur(anual.gastosTotales)}</div>
            <div class="muted" style="font-size:11px;">Deducibles ${eur(anual.gastosDeducibles)} + no deducibles ${eur(anual.gastosNoDeducibles)}</div>
          </div>
          <div>
            <div class="muted" style="font-size:11px; text-transform:uppercase; letter-spacing:.06em; font-weight:700;">Beneficio real (cobrado)</div>
            <div style="font-size:22px; font-weight:800; margin:6px 0 2px; letter-spacing:-.02em; color:var(--green-fg);">${eur(anual.beneficioRealPagado)}</div>
            <div class="muted" style="font-size:11px;">Cobrado − gastos totales</div>
          </div>
        </div>
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

    const ctxServicio = container.querySelector("#chart-ingresos-servicio");
    if (ctxServicio && window.Chart) {
      if (chartIngresosServicio) { chartIngresosServicio.destroy(); chartIngresosServicio = null; }
      const labels = ingresosEntradas.map(([k]) => (CATEGORIAS_SERVICIO[k]||CATEGORIAS_SERVICIO.otros).label);
      const data = ingresosEntradas.map(([,v]) => v);
      const colors = ingresosEntradas.map(([k]) => (CATEGORIAS_SERVICIO[k]||CATEGORIAS_SERVICIO.otros).fg);
      chartIngresosServicio = new window.Chart(ctxServicio, {
        type: "doughnut",
        data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0 }] },
        options: {
          maintainAspectRatio: false,
          plugins: { legend: { position: "right", labels: { boxWidth: 10, font: { size: 11 } } } },
        },
      });
    }
  }
}
