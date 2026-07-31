import { db } from "../supabase.js";
import { eur, CATEGORIAS_SERVICIO, CATEGORIAS_GASTO } from "../utils/format.js";
import { calcularModelo130Trimestral, gastoDeducibleEnRango, round2, gastoDificilJustificacion, PLAZOS_MODELO_130_2026 } from "../utils/invoice-calc.js";
import { construirLedger, resumenPeriodo, resumenTrimestre, resumenIvaTrimestre, rangoMes, rangoAnio } from "../utils/resumen.js";
import { getConfig } from "../utils/config-usuario.js";
import { skeletonPagina, animarVista } from "../utils/ui.js";
import { opcionesBase, opcionesDoughnut, barra, barraApilada } from "../utils/charts.js";

const MESES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
let chartMensual = null;
let chartIngresosServicio = null;
let chartBeneficioFin = null;
let chartFormaPago = null;

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

// La deducción por "gastos de difícil justificación" vivía aquí duplicada.
// Ahora se importa de invoice-calc.js: tenerla en dos sitios fue justo lo que
// provocó que el Dashboard y esta pantalla mostraran cifras distintas del
// Modelo 130 para el mismo trimestre.

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
  container.innerHTML = skeletonPagina({ kpis: 4, filas: 8 });

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
  const cfg = getConfig();

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

    // El KPI "(cobrado)" compara dinero ya cobrado (que por definición nunca
    // incluye meses futuros) contra gastos deducibles: si se calculan estos
    // hasta el 31/12 se cuelan cuotas de amortización de meses que aún no han
    // pasado (p. ej. la de octubre estando a julio), inflando el gasto frente
    // al ingreso y hundiendo artificialmente el beneficio. Para que ambos
    // lados de la resta usen la misma fecha de corte, en el año en curso
    // topamos el rango de gastos en "hoy".
    const hoyIso = new Date().toISOString().slice(0, 10);
    const hastaCobrado = (anio === anioActual && hoyIso < hasta) ? hoyIso : hasta;
    const anualCobrado = hastaCobrado === hasta ? anual : resumenPeriodo(ledger, gastos, desde, hastaCobrado);

    // --- Mensual (para la gráfica) ---
    const porMes = MESES.map((_, i) => {
      const r = rangoMes(anio, i);
      return resumenPeriodo(ledger, gastos, r.desde, r.hasta);
    });

    // --- Trimestral (Modelo 130) --- Solo lo ya cobrado (pagada), según lo
    // pedido. Método "plano": % configurable (ver Configuración) sobre el
    // rendimiento neto de CADA trimestre por separado, sin acumular con
    // trimestres anteriores del año — así lo usa Josep mientras esté en su
    // situación actual. Igual que en el KPI "(cobrado)", los gastos de un
    // trimestre que aún no ha terminado se topan en la fecha de hoy (si no,
    // se colarían cuotas de amortización de meses futuros).
    const hoyIsoQ = new Date().toISOString().slice(0, 10);
    let acumuladoDificilJustificacion = 0;
    const presentados = leerPresentados();
    const trimestres = [1,2,3,4].map(q => {
      const t = resumenTrimestre(ledger, facturas, gastos, anio, q);
      const hastaCap = t.hasta > hoyIsoQ ? hoyIsoQ : t.hasta;
      const gastosDeduciblesCap = hastaCap === t.hasta ? t.gastosDeducibles : resumenPeriodo(ledger, gastos, t.desde, hastaCap).gastosDeducibles;
      const dificilJustificacion = gastoDificilJustificacion(t.transferenciaPagada, gastosDeduciblesCap, acumuladoDificilJustificacion);
      acumuladoDificilJustificacion = round2(acumuladoDificilJustificacion + dificilJustificacion);
      const gastosConDificilJustificacion = round2(gastosDeduciblesCap + dificilJustificacion);
      const r = calcularModelo130Trimestral({ ingresosTrimestre: t.transferenciaPagada, gastosTrimestre: gastosConDificilJustificacion, retencionesTrimestre: t.retenciones, pctModelo130: cfg.modelo130_pct });
      const plazo = PLAZOS_MODELO_130_2026[q-1];
      const presentado = !!presentados[`${anio}-T${q}`];
      return { q, ...t, gastosDeducibles: gastosDeduciblesCap, dificilJustificacion, gastosConDificilJustificacion, ...r, plazo, presentado };
    });

    // --- Trimestral (IVA — Modelo 303). A diferencia del Modelo 130 de arriba
    // (que solo cuenta lo ya cobrado), la base del IVA sale de los PROYECTOS
    // entregados en el trimestre y cobrados por transferencia: en servicios el
    // IVA se devenga al prestar el servicio, no al emitir la factura, así que
    // contar por proyecto no deja fuera los trabajos aún sin factura o
    // pendientes de una factura conjunta. El efectivo no entra. El soportado
    // sale de los gastos con factura, de golpe (sin prorratear como la
    // amortización del IRPF). Si un trimestre sale negativo, ese crédito se
    // compensa en el siguiente.
    let creditoIvaAcumulado = 0;
    const ivaTrimestres = [1,2,3,4].map(q => {
      const t = resumenIvaTrimestre(ledger, facturas, gastos, anio, q);
      const neto = round2(t.resultado - creditoIvaAcumulado);
      const aIngresar = neto > 0 ? neto : 0;
      const aCompensar = neto < 0 ? round2(-neto) : 0;
      creditoIvaAcumulado = aCompensar;
      const plazo = PLAZOS_MODELO_130_2026[q-1];
      return { ...t, neto, aIngresar, aCompensar, plazo };
    });

    const hoy = new Date();
    const trimestreActual = Math.floor(hoy.getMonth()/3) + 1;
    const proximoTrimestre = trimestres[trimestreActual - 1] || trimestres[0];
    const plazoProximoVencido = new Date(proximoTrimestre.plazo.fin) < hoy;
    const ivaTrimestreActual = ivaTrimestres[trimestreActual - 1] || ivaTrimestres[0];

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
    const irpfEstimadoAcumulado = round2(trimestres.reduce((s,t)=>s+t.aIngresar,0));
    const beneficioNetoEstimado = round2(resultadoAntesImpuestos - irpfEstimadoAcumulado);
    const numProyectosPL = anual.filas.length;
    const margenPct = totalIngresosPL ? round2(resultadoAntesImpuestos / totalIngresosPL * 100) : 0;
    const ticketMedio = numProyectosPL ? round2(totalIngresosPL / numProyectosPL) : 0;
    const gastoMedioProyecto = numProyectosPL ? round2(totalGastosPL / numProyectosPL) : 0;

    container.querySelector("#financiero-body").innerHTML = `
      <div class="grid grid-4" style="margin-bottom:20px;">
        <div class="card kpi"><div class="label">Cobrado por transferencia ${anio}</div><div class="value">${eur(anual.transferenciaPagada)}</div><div class="muted" style="font-size:11px;">${eur(anual.transferenciaNoPagada)} facturado y aún sin cobrar</div></div>
        <div class="card kpi"><div class="label">Gastos deducibles ${anio}</div><div class="value">${eur(anual.gastosDeducibles)}</div><div class="muted" style="font-size:11px;">+ ${eur(acumuladoDificilJustificacion)} difícil justificación</div></div>
        <div class="card kpi"><div class="label">Beneficio fiscal neto (cobrado)</div><div class="value" style="color:var(--green-fg)">${eur(anualCobrado.beneficioFiscalPagado)}</div><div class="muted" style="font-size:11px;">Cobrado y gastos, ambos hasta hoy</div></div>
        <div class="card kpi dark" style="${plazoProximoVencido && !proximoTrimestre.presentado ? "outline:2px solid #E8985B;" : ""}">
          <div class="label">${proximoTrimestre.presentado ? "Modelo 130 (T"+trimestreActual+")" : "Pendiente de presentar — T"+trimestreActual}</div>
          <div class="value">${eur(proximoTrimestre.aIngresar)}</div>
          <div style="font-size:11px;color:${plazoProximoVencido && !proximoTrimestre.presentado ? "#F5B896" : "#8FD6B3"};">
            ${proximoTrimestre.presentado ? "Marcado como presentado ✓" : (plazoProximoVencido ? "Plazo vencido el " + proximoTrimestre.plazo.fin : "Vence " + proximoTrimestre.plazo.fin)}
          </div>
          <div style="font-size:11px; color:#B9C0DA; margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,.12);">
            + IVA (Modelo 303, T${trimestreActual}): <strong style="color:#fff;">${ivaTrimestreActual.aIngresar > 0 ? eur(ivaTrimestreActual.aIngresar) : (ivaTrimestreActual.aCompensar > 0 ? eur(ivaTrimestreActual.aCompensar) + " a compensar" : eur(0))}</strong>
          </div>
        </div>
      </div>

      <div class="card" style="border-left:4px solid var(--purple-fg, #6B3FA0); margin-bottom:20px;">
        <div class="card-head"><h3>Balance real (personal)</h3><span class="help-tip" title="Incluye también el efectivo y los gastos no deducibles — es lo que de verdad ha entrado y salido de tu bolsillo (solo cobros ya marcados como pagados).">i</span></div>
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

      <div class="grid grid-side" style="margin-bottom:20px; align-items:start;">
        <div class="card">
          <div class="card-head"><h3>Cuenta de resultados</h3><span class="help-tip" title="Acumulado ${anio} · facturado (no solo cobrado), coste real de los gastos (con amortizaciones prorrateadas).">i</span></div>
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
            <div class="card-head">
              <h3>Transferencia vs efectivo</h3>
              <span class="help-tip" title="Reparto de TODO lo facturado del año por forma de pago (base imponible), tanto lo ya cobrado como lo que sigue pendiente. Importa porque solo la transferencia entra en el Modelo 130.">i</span>
            </div>
            <div id="wrap-forma-pago" style="position:relative; height:170px;"><canvas id="chart-forma-pago"></canvas></div>
            <p class="hint-sm" style="margin:10px 0 0;">
              Total facturado ${anio}: <strong>${eur(round2(anual.transferencia + anual.efectivo))}</strong>${
                anual.noPagado > 0 ? ` · ${eur(anual.noPagado)} aún sin cobrar` : ""
              }
            </p>
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
        <div class="card-head">
          <h3>Beneficio mensual ${anio} <span class="muted" style="font-weight:400; font-size:12px;">(facturado − gastos del mes)</span></h3>
          <span class="help-tip" title="Solo meses ya cerrados. Los que aún no han llegado no se dibujan: llevan la cuota de autónomo y la gestoría dadas de alta por adelantado pero todavía no tienen ingresos, así que saldrían en rojo como si el negocio perdiera dinero.">i</span>
        </div>
        <div style="position:relative; height:220px;"><canvas id="chart-beneficio-financiero"></canvas></div>
      </div>

      <div class="card" style="margin-bottom:20px;">
        <div class="card-head"><h3>Beneficio mes a mes ${anio}</h3><span class="help-tip" title="Facturado (base imponible) − gastos del mes = beneficio mensual. Los meses que todavía no han llegado se marcan como previstos: ya tienen los gastos fijos dados de alta pero aún no los ingresos.">i</span></div>
        <div class="grid grid-4">
          ${porMes.map((m, i) => {
            // Mes que aún no ha llegado: tiene los gastos fijos dados de alta
            // por adelantado y ningún ingreso todavía, así que su "beneficio"
            // negativo no significa nada. Se marca como previsto y se atenúa
            // en vez de pintarlo en rojo como una pérdida real.
            const esFuturo = anio > anioActual || (anio === anioActual && i > hoy.getMonth());
            const beneficioMes = round2(m.totalBase - m.gastosTotales);
            const positivo = beneficioMes >= 0;
            const color = esFuturo ? "var(--grey)" : (positivo ? "var(--green-fg)" : "var(--red-fg)");
            return `<div class="card${esFuturo ? " proyectado" : ""}" style="box-shadow:none; padding:14px; border-left:4px solid ${color};">
              <div style="display:flex; align-items:center; gap:6px; margin-bottom:8px;">
                <span style="font-weight:700; font-size:13px;">${MESES[i]} ${anio}</span>
                ${esFuturo ? `<span class="badge badge-proyectado">Previsto</span>` : ""}
              </div>
              <div style="font-size:20px; font-weight:800; letter-spacing:-.02em; color:${color};">${eur(beneficioMes)}</div>
              <div class="stat-note" style="margin-bottom:10px;">${esFuturo ? "solo gastos fijos, sin ingresos aún" : "beneficio mensual"}</div>
              <div style="font-size:12px; display:flex; flex-direction:column; gap:4px; border-top:1px solid var(--border); padding-top:8px;">
                <div style="display:flex; justify-content:space-between;"><span class="muted">Facturado</span><span>${eur(m.totalBase)}</span></div>
                <div style="display:flex; justify-content:space-between;"><span class="muted">Gastos</span><span>−${eur(m.gastosTotales)}</span></div>
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>

      <div class="card" style="margin-bottom:20px;">
        <div class="card-head"><h3>Modelo 130 — pago fraccionado trimestral</h3><span class="help-tip" title='Se aplica el ${cfg.modelo130_pct}% (editable en Configuración) sobre (cobrado − gastos deducibles) de CADA trimestre por separado, sin acumular con trimestres anteriores. Solo cuenta lo ya cobrado por transferencia (marcado como "pagada" en Facturación mensual) e incluye la deducción automática por "difícil justificación" (5%, tope 2.000€/año) que también aplica tu gestoría.'>i</span></div>
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
        <p class="muted" style="font-size:11px; margin-top:8px;">Estimación orientativa — confírmala con tu gestor/a antes de presentar.</p>
      </div>

      <div class="card" style="margin-bottom:20px;">
        <div class="card-head"><h3>IVA — Modelo 303 trimestral</h3><span class="help-tip" title="El IVA repercutido se calcula sobre los PROYECTOS entregados en el trimestre y cobrados (o a cobrar) por transferencia, no sobre las facturas emitidas: en servicios el IVA se devenga al prestar el servicio, y así no se quedan fuera los trabajos aún sin factura o pendientes de una factura conjunta. Los proyectos en efectivo no cuentan. El soportado sale del IVA de tus gastos con factura. Si un trimestre sale a favor, ese crédito se resta del siguiente.">i</span></div>
        <div class="grid grid-4">
          ${ivaTrimestres.map(t => {
            const vencido = new Date(t.plazo.fin) < hoy;
            const aFavor = t.aIngresar === 0 && t.aCompensar > 0;
            const borderColor = aFavor ? "var(--green-fg)" : (vencido ? "var(--orange-fg)" : "var(--blue)");
            const badge = aFavor
              ? `<span class="badge" style="background:var(--green-bg); color:var(--green-fg);">A compensar</span>`
              : (vencido ? `<span class="badge" style="background:var(--orange-bg); color:var(--orange-fg);">Vencido</span>` : `<span class="badge" style="background:var(--grey-bg); color:var(--grey-fg);">Pendiente</span>`);
            return `<div class="card" style="box-shadow:none; padding:16px; border-left:4px solid ${borderColor};">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                <span style="font-weight:700; font-size:13px;">T${t.q} ${anio}</span>
                ${badge}
              </div>
              <div style="font-size:22px; font-weight:800; letter-spacing:-.02em; color:${aFavor ? "var(--green-fg)" : "var(--text)"};">${aFavor ? eur(t.aCompensar) : eur(t.aIngresar)}</div>
              <div class="muted" style="font-size:11px; margin-bottom:12px;">${aFavor ? "a favor · se compensa en T"+(t.q+1<=4?t.q+1:"1 del año siguiente") : "a ingresar"} · plazo ${t.plazo.inicio.slice(8,10)}–${t.plazo.fin.slice(8,10)}/${t.plazo.fin.slice(5,7)}</div>
              <div style="font-size:12px; display:flex; flex-direction:column; gap:4px; border-top:1px solid var(--border); padding-top:10px;">
                <div style="display:flex; justify-content:space-between;"><span class="muted">IVA repercutido</span><span>${eur(t.ivaRepercutido)}</span></div>
                <div style="display:flex; justify-content:space-between;"><span class="muted">IVA soportado</span><span>−${eur(t.ivaSoportado)}</span></div>
                <div style="display:flex; justify-content:space-between;"><span class="muted">Base (transferencia)</span><span>${eur(t.baseRepercutida)}</span></div>
              </div>
              ${t.baseSinFacturar > 0 ? `
                <div class="hint-box" style="margin-top:10px; font-size:11px;">
                  Quedan <strong>${eur(t.baseSinFacturar)}</strong> de base sin factura emitida.
                  Emítelas antes de presentar el trimestre.
                </div>` : ""}
            </div>`;
          }).join("")}
        </div>
        <div class="muted" style="font-size:12px; margin-top:16px; display:flex; justify-content:space-between; flex-wrap:wrap; gap:6px; border-top:1px solid var(--border); padding-top:12px;">
          <span>Total ${anio}: base ${eur(ivaTrimestres.reduce((s,t)=>s+t.baseRepercutida,0))} · repercutido ${eur(ivaTrimestres.reduce((s,t)=>s+t.ivaRepercutido,0))} · soportado ${eur(ivaTrimestres.reduce((s,t)=>s+t.ivaSoportado,0))}</span>
          <strong style="color:var(--text);">A ingresar total: ${eur(ivaTrimestres.reduce((s,t)=>s+t.aIngresar,0))}</strong>
        </div>
        <p class="muted" style="font-size:11px; margin-top:8px;">Estimación orientativa — confírmala con tu gestor/a antes de presentar.</p>
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
      // Tres tramos apilados. La tapa redondeada la lleva el que quede arriba
      // en cada mes: "sin cobrar" si lo hay, si no el efectivo, y si tampoco
      // hay efectivo, la transferencia (ver barraApilada en charts.js).
      const dTransferencia = porMes.map(m => m.transferenciaPagada);
      const dEfectivo = porMes.map(m => m.efectivoPagada);
      const dSinCobrar = porMes.map(m => m.noPagado);
      const sumaPorEncimaDeTransferencia = dEfectivo.map((v, i) => v + dSinCobrar[i]);
      chartMensual = new window.Chart(ctx, {
        type: "bar",
        data: {
          labels: MESES,
          datasets: [
            { label: "Transferencia (cobrado)", data: dTransferencia, ...barraApilada("#3E6FE0", { encimaDe: sumaPorEncimaDeTransferencia }), stack: "s" },
            { label: "Efectivo (cobrado)", data: dEfectivo, ...barraApilada("#F2B84B", { encimaDe: dSinCobrar }), stack: "s" },
            { label: "Aún sin cobrar", data: dSinCobrar, ...barraApilada("#C6CCE0"), stack: "s" },
          ],
        },
        options: (() => {
          const o = opcionesBase(eur);
          o.scales.x.stacked = true;
          o.scales.y.stacked = true;
          return o;
        })(),
      });
    }

    const ctxBeneficio = container.querySelector("#chart-beneficio-financiero");
    if (ctxBeneficio && window.Chart) {
      if (chartBeneficioFin) { chartBeneficioFin.destroy(); chartBeneficioFin = null; }
      // Igual que en Dashboard: los meses que aún no han llegado se dejan en
      // null para que Chart.js no los pinte (ver comentario del help-tip).
      const mesActualIdx = hoy.getMonth();
      const beneficioPorMes = porMes.map((m, i) =>
        (anio > anioActual || (anio === anioActual && i > mesActualIdx))
          ? null
          : round2(m.totalBase - m.gastosTotales)
      );
      chartBeneficioFin = new window.Chart(ctxBeneficio, {
        type: "bar",
        data: {
          labels: MESES,
          datasets: [{
            label: "Beneficio",
            data: beneficioPorMes,
            // Serie única: sí lleva degradado, y el color se resuelve barra a
            // barra según sea beneficio (verde) o pérdida (rojo).
            backgroundColor: (ctx) => {
              const v = beneficioPorMes[ctx.dataIndex];
              if (v === null || v === undefined) return "transparent";
              return barra(v >= 0 ? "#3FA97A" : "#C4564A").backgroundColor(ctx);
            },
            borderRadius: { topLeft: 7, topRight: 7, bottomLeft: 0, bottomRight: 0 },
            borderSkipped: false,
            maxBarThickness: 34,
            categoryPercentage: 0.68,
            barPercentage: 0.85,
          }],
        },
        options: (() => {
          const o = opcionesBase(eur);
          o.plugins.legend.display = false;
          return o;
        })(),
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
        data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0, spacing: 3, hoverOffset: 8 }] },
        options: opcionesDoughnut(eur, { leyenda: "right" }),
      });
    }

    // Reparto por forma de pago sobre TODO lo facturado del año (cobrado o no),
    // que es lo pedido: anual.transferencia y anual.efectivo ya son los totales
    // por forma de pago sin filtrar por estado de cobro. Se mantienen los
    // mismos colores que en la gráfica de facturación mensual (azul =
    // transferencia, ámbar = efectivo) para poder leerlas sin pensar.
    const ctxFormaPago = container.querySelector("#chart-forma-pago");
    if (ctxFormaPago && window.Chart) {
      if (chartFormaPago) { chartFormaPago.destroy(); chartFormaPago = null; }
      const datosFormaPago = [anual.transferencia, anual.efectivo];
      if (!datosFormaPago.some(v => v > 0)) {
        container.querySelector("#wrap-forma-pago").innerHTML =
          `<p class="muted" style="padding-top:20px;">Todavía no hay nada facturado en ${anio}.</p>`;
      } else {
        chartFormaPago = new window.Chart(ctxFormaPago, {
          type: "doughnut",
          data: {
            labels: ["Transferencia", "Efectivo"],
            datasets: [{
              data: datosFormaPago,
              backgroundColor: ["#3E6FE0", "#F2B84B"],
              borderWidth: 0, spacing: 3, hoverOffset: 8,
            }],
          },
          options: opcionesDoughnut(eur, { leyenda: "right" }),
        });
      }
    }

    animarVista(container);
  }
}
