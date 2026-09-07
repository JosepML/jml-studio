import { db } from "../supabase.js";
import { eur, ESTADOS_PROYECTO, ESTADOS_COBRO } from "../utils/format.js";
import { calcularModelo130Trimestral, round2 } from "../utils/invoice-calc.js";
import { construirLedger, resumenPeriodo, resumenTrimestre, resumenIvaTrimestre, rangoMes, rangoAnio, conIva, estadoEfectivo, conIvaSegunPago } from "../utils/resumen.js";
import { escapeHtml } from "./clientes.js";
import { getConfig } from "../utils/config-usuario.js";
import { skeletonPagina, animarVista } from "../utils/ui.js";
import { opcionesBase, opcionesDoughnut, barra, barraApilada, leyendaConTotales } from "../utils/charts.js";
import { montarCalendario } from "./calendario.js";

const MESES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
let chartMensualDash = null;
let chartEstados = null;
let chartBeneficioDash = null;

export async function renderDashboard(container) {
  container.innerHTML = skeletonPagina({ kpis: 4, filas: 6 });

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
  // Fiscalmente solo entran trabajos ya emitidos (emitidos o pagados). Los
  // proyectos aún pendientes de emitir se excluyen hasta que se formalicen.
  const ledgerEmitido = ledger.filter(f => estadoEfectivo(f) !== "pendiente");
  const hoy = new Date();
  const anio = hoy.getFullYear();
  const qActual = Math.floor(hoy.getMonth()/3) + 1;

  const rMes = rangoMes(anio, hoy.getMonth());
  const resumenMes = resumenPeriodo(ledger, gastos, rMes.desde, rMes.hasta);
  const rAnio = rangoAnio(anio);
  const resumenAnual = resumenPeriodo(ledger, gastos, rAnio.desde, rAnio.hasta);
  // Igual que en Financiero: el KPI "(cobrado)" no puede comparar ingresos
  // cobrados hasta hoy con gastos deducibles proyectados hasta el 31/12 (las
  // cuotas de amortización de meses futuros se contarían de más). Se topa el
  // rango de gastos en hoy para que ambos lados usen la misma fecha de corte.
  const hoyIso = hoy.toISOString().slice(0, 10);
  const hastaCobrado = hoyIso < rAnio.hasta ? hoyIso : rAnio.hasta;
  const resumenAnualCobrado = hastaCobrado === rAnio.hasta ? resumenAnual : resumenPeriodo(ledger, gastos, rAnio.desde, hastaCobrado);

  const porMes = MESES.map((_, i) => resumenPeriodo(ledger, gastos, rangoMes(anio,i).desde, rangoMes(anio,i).hasta));

  // Previsión del trimestre actual: facturación menos gastos deducibles.
  // Para no anticipar cifras futuras, el trimestre en curso se corta en hoy.
  const cfg = getConfig();
  const trimestre = resumenTrimestre(ledgerEmitido, facturas, gastos, anio, qActual);
  const hastaTrimestre = trimestre.hasta > hoyIso ? hoyIso : trimestre.hasta;
  const trimestreCorte = hastaTrimestre === trimestre.hasta
    ? trimestre
    : resumenPeriodo(ledgerEmitido, gastos, trimestre.desde, hastaTrimestre);
  const provision = calcularModelo130Trimestral({
    ingresosTrimestre: trimestreCorte.totalBase,
    gastosTrimestre: trimestreCorte.gastosDeducibles,
    retencionesTrimestre: 0,
    pctModelo130: cfg.modelo130_pct,
  });
  const ivaTrimestre = resumenIvaTrimestre(ledgerEmitido, facturas, gastos, anio, qActual);
  const ivaAPagar = round2(Math.max(ivaTrimestre.resultado, 0));

  // Son dos listas distintas: "en curso" son proyectos aún no emitidos y
  // "pendiente de cobro" son solo los ya emitidos que siguen sin pagar.
  // Para los importes pendientes solo cuentan trabajos con fecha de hoy o
  // anterior: un proyecto futuro no es todavía una deuda.
  const vencidos = ledger.filter(f => !f.fecha || f.fecha <= hoyIso);
  const pendientes = vencidos.filter(f => estadoEfectivo(f) === "emitida");
  const pendienteTotal = ledger
    .filter(f => estadoEfectivo(f) === "pendiente" && (!f.fecha || f.fecha <= hoyIso))
    .reduce((s,f)=>s+conIvaSegunPago(f.importeBase, f.proyecto.forma_pago),0);
  const enCurso = ledger.filter(f => estadoEfectivo(f) === "pendiente").slice(0, 8);

  const porEstado = Object.keys(ESTADOS_COBRO).map(k => ({ key: k, label: ESTADOS_COBRO[k].label, fg: ESTADOS_COBRO[k].fg, count: ledger.filter(f=>estadoEfectivo(f)===k).length }));

  container.innerHTML = `
    <div class="grid grid-5" style="margin-bottom:20px;">
      <div class="card kpi"><div class="label">Facturado este mes</div><div class="value">${eur(resumenMes.transferencia + resumenMes.efectivo)}</div></div>
      <div class="card kpi"><div class="label">Pendiente de facturar</div><div class="value">${eur(pendienteTotal)}</div></div>
      <div class="card kpi"><div class="label">Beneficio fiscal (cobrado, año)</div><div class="value pos">${eur(resumenAnualCobrado.beneficioFiscalPagado)}</div></div>
      <div class="card kpi impuesto-irpf"><div class="label">IRPF previsto · T${qActual}</div><div class="value">${eur(provision.aIngresar)}</div></div>
      <div class="card kpi impuesto-iva"><div class="label">IVA previsto · T${qActual}</div><div class="value">${eur(ivaAPagar)}</div></div>
    </div>

    <!-- El calendario es un widget acotado a la izquierda y las tres gráficas
         van apiladas a su derecha, para no dejar medio Dashboard en blanco. -->
    <div class="dash-fila-cal">
      <div class="card" id="dash-calendario"></div>

      <div class="dash-graficas">
        <div class="card">
          <h3>Facturación ${anio} <span class="muted" style="font-weight:400; font-size:12px;">(transferencia vs. efectivo)</span></h3>
          <div class="grafica"><canvas id="chart-dash-mensual" role="img" aria-label="Facturación mensual por transferencia y efectivo"></canvas></div>
        </div>
        <div class="card">
          <div class="card-head">
            <h3>Beneficio mensual ${anio} <span class="muted" style="font-weight:400; font-size:12px;">(facturado − gastos del mes)</span></h3>
            <span class="help-tip" title="Solo meses ya cerrados. Los meses que aún no han llegado no se dibujan: llevan la cuota de autónomo y la gestoría dadas de alta por adelantado pero todavía no tienen ingresos, así que saldrían en rojo como si el negocio perdiera dinero.">i</span>
          </div>
          <div class="grafica"><canvas id="chart-dash-beneficio" role="img" aria-label="Beneficio mensual"></canvas></div>
        </div>
        <div class="card">
          <h3>Proyectos por estado</h3>
          <div class="grafica"><canvas id="chart-dash-estados" role="img" aria-label="Distribución de proyectos por estado de cobro"></canvas></div>
        </div>
      </div>
    </div>

    <div class="grid grid-2" style="margin-bottom:20px;">
      <!-- Orden a propósito: primero "en curso" y después "pendiente de cobro",
           siguiendo el ciclo real de un trabajo (se hace → se factura → se
           cobra) en vez de al contrario. -->
      <div class="card">
        <div class="card-head"><h3>Proyectos en curso</h3><span class="help-tip" title="Proyectos creados y todavía sin facturar. En cuanto se emiten pasan a Pendiente de cobro.">i</span></div>
        <!-- Antes esto era una lista de <div> con float, así que no se parecía
             en nada a la tabla de al lado y no se resaltaba la fila al pasar el
             ratón. Ahora es una tabla con las mismas columnas y clases, de modo
             que hereda el mismo encabezado, la misma alineación de importes y
             el mismo realce de fila (tr.clickable:hover) que Pendiente de cobro. -->
        <table>
          <thead><tr><th>Proyecto</th><th>Cliente</th><th class="money">Importe</th></tr></thead>
          <tbody>${enCurso.map(f => `<tr class="clickable" data-proyecto-id="${f.proyecto.id}"><td><strong>${escapeHtml(f.proyecto.nombre)}</strong></td><td>${escapeHtml(clientesMap[f.proyecto.cliente_id]||"—")}</td><td class="money">${eur(f.importeBase)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">No hay proyectos sin facturar. <a href="#/proyectos">Crea uno</a>.</td></tr>`}</tbody>
        </table>
      </div>
      <div class="card">
        <div class="card-head"><h3>Pendiente de cobro</h3><span class="help-tip" title="Proyectos ya emitidos que todavía no se han cobrado.">i</span></div>
        <table>
          <thead><tr><th>Proyecto</th><th>Cliente</th><th class="money">Importe c/IVA</th></tr></thead>
          <tbody>${pendientes.slice(0,8).map(f => `<tr class="clickable" data-proyecto-id="${f.proyecto.id}"><td><strong>${escapeHtml(f.proyecto.nombre)}</strong></td><td>${escapeHtml(clientesMap[f.proyecto.cliente_id]||"—")}</td><td class="money">${eur(conIvaSegunPago(f.importeBase, f.proyecto.forma_pago))}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">Nada pendiente 🎉</td></tr>`}</tbody>
        </table>
        ${pendientes.length ? `<p style="margin-top:10px;"><a href="#/mensual">Ver y marcar como pagadas →</a></p>` : ""}
      </div>
    </div>`;

  container.querySelectorAll("[data-proyecto-id]").forEach(el => {
    el.style.cursor = "pointer";
    el.addEventListener("click", () => { location.hash = `#/proyectos/${el.dataset.proyectoId}`; });
  });

  const ctxMes = container.querySelector("#chart-dash-mensual");
  if (ctxMes && window.Chart) {
    if (chartMensualDash) { chartMensualDash.destroy(); chartMensualDash = null; }
    // El efectivo va apilado encima de la transferencia, así que la
    // transferencia solo lleva tapa redondeada en los meses sin efectivo
    // (ver barraApilada en charts.js).
    const datosTransferencia = porMes.map(m => m.transferencia);
    const datosEfectivo = porMes.map(m => m.efectivo);
    chartMensualDash = new window.Chart(ctxMes, {
      type: "bar",
      data: {
        labels: MESES,
        datasets: [
          { label: "Transferencia", data: datosTransferencia, ...barraApilada("#3E6FE0", { encimaDe: datosEfectivo }), stack: "s" },
          { label: "Efectivo", data: datosEfectivo, ...barraApilada("#F2B84B", { texturaTipo: "diagonal" }), stack: "s" },
        ],
      },
      options: (() => {
        const o = opcionesBase(eur);
        Object.assign(o.plugins.legend.labels, leyendaConTotales(eur));
        o.scales.x.stacked = true;
        o.scales.y.stacked = true;
        return o;
      })(),
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
        datasets: [{
          data: conDatos.map(e=>e.count),
          backgroundColor: conDatos.map(e=>e.fg),
          borderWidth: 0,
          spacing: 3,
          hoverOffset: 8,
        }],
      },
      options: opcionesDoughnut(v => `${v} proyecto${v === 1 ? "" : "s"}`),
    });
  }

  const ctxBeneficio = container.querySelector("#chart-dash-beneficio");
  if (ctxBeneficio && window.Chart) {
    if (chartBeneficioDash) { chartBeneficioDash.destroy(); chartBeneficioDash = null; }
    // Solo meses ya cerrados (hasta el actual incluido). Los siguientes ya
    // tienen la cuota de autónomo y la gestoría dadas de alta por adelantado
    // pero aún no tienen ingresos, así que se dibujaban en rojo bajo cero y
    // parecía que el negocio perdía dinero cuatro meses al año. Con null,
    // Chart.js simplemente no pinta esas barras.
    const mesActual = hoy.getMonth();
    const beneficioPorMes = porMes.map((m, i) =>
      i > mesActual ? null : Math.round((m.totalBase - m.gastosTotales) * 100) / 100
    );
    chartBeneficioDash = new window.Chart(ctxBeneficio, {
      type: "bar",
      data: {
        labels: MESES,
        datasets: [{
          label: "Beneficio",
          data: beneficioPorMes,
          // Cada barra lleva su propio degradado según sea beneficio o
          // pérdida, así que el color se resuelve barra a barra.
          backgroundColor: (ctx) => {
            const v = beneficioPorMes[ctx.dataIndex];
            if (v === null || v === undefined) return "transparent";
            return barra(v >= 0 ? "#3FA97A" : "#C4564A").backgroundColor(ctx);
          },
          borderRadius: { topLeft: 6, topRight: 6, bottomLeft: 0, bottomRight: 0 },
          borderSkipped: false,
          maxBarThickness: 46,
        }],
      },
      options: (() => {
        const o = opcionesBase(eur);
        o.plugins.legend.display = false;
        return o;
      })(),
    });
  }

  // El calendario se monta aparte porque habla con Google, no con Supabase:
  // se pinta al momento y va rellenando los eventos cuando llegan.
  const $cal = container.querySelector("#dash-calendario");
  if ($cal) montarCalendario($cal);

  // Números que cuentan hasta su valor y tarjetas que entran escalonadas.
  animarVista(container);
}
