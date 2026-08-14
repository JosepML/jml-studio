import { db } from "../supabase.js";
import { eur, dateEs, todayIso, CATEGORIAS_GASTO } from "../utils/format.js";
import { gastoDeducibleTotal, sumaGastosDeduciblesEnRango, round2 } from "../utils/invoice-calc.js";
import { TABLA_AMORTIZACION, mesesPorTipoBien, UMBRAL_AMORTIZACION } from "../utils/amortizacion.js";
import { escapeHtml, escapeAttr } from "./clientes.js";
import { toastOk, toastError, confirmarBorrado, skeletonPagina, animarVista } from "../utils/ui.js";
import { opcionesDoughnut } from "../utils/charts.js";

const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
let chartCategorias = null;

export async function renderGastos(container, param) {
  container.innerHTML = skeletonPagina({ kpis: 4, filas: 8 });

  const { data: gastos, error } = await db.from("gastos").select("*").order("fecha", { ascending: false }).exec();
  if (error) { container.innerHTML = `<p class="muted">Error cargando gastos: ${error}</p>`; return; }

  const anioActual = new Date().getFullYear();
  const anios = Array.from(new Set([...(gastos || []).map(g => new Date(g.fecha).getFullYear()), anioActual])).sort((a,b)=>b-a);

  container.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-filters">
        <div class="segmented" id="seg-deducible">
          <button data-val="" class="active" type="button">Todos</button>
          <button data-val="si" type="button">Deducibles</button>
          <button data-val="no" type="button">No deducibles</button>
        </div>
        <label>Año</label>
        <select id="sel-anio">${anios.map(a => `<option value="${a}" ${a===anioActual?"selected":""}>${a}</option>`).join("")}</select>
      </div>
      <div class="toolbar-action exportar-grupo">
        <span class="exportar-etiqueta">Exportar</span>
        <button class="btn btn-ghost" type="button" data-exportar="excel">⤓ Excel</button>
        <button class="btn btn-ghost" type="button" data-exportar="pdf">⤓ PDF</button>
      </div>
      <button class="btn btn-primary toolbar-action" id="btn-nuevo-gasto">+ Añadir gasto</button>
    </div>
    <div id="gasto-form-wrap"></div>
    <div id="gastos-resumen" class="grid grid-4" style="margin-bottom:20px;"></div>
    <div class="grid grid-2" style="margin-bottom:20px;">
      <div class="card">
        <div class="card-head"><h3>Por categoría</h3><span class="help-tip" title="Pulsa una categoría para filtrar el listado de abajo.">i</span></div>
        <div id="categorias-chips" class="chip-row"></div>
      </div>
      <div class="card">
        <h3>Reparto del gasto</h3>
        <div style="position:relative; height:180px;"><canvas id="chart-categorias"></canvas></div>
      </div>
    </div>
    <div id="gastos-meses"></div>
  `;

  container.querySelector("#btn-nuevo-gasto").addEventListener("click", () => abrirFormulario(container, null, () => renderGastos(container)));

  // Igual que en Proyectos y Clientes: "+ Crear → Nuevo gasto" entra por
  // #/gastos/nuevo y el formulario aparece solo.
  // Ojo: el arranque pinta la vista dos veces (la segunda al llegar los datos
  // del emisor), así que sin esta guarda el diálogo se abría por duplicado.
  if (param === "nuevo" && !document.querySelector(".modal-backdrop")) abrirFormulario(container, null, () => renderGastos(container));
  const exportar = async (e) => {
    const $btn = e.currentTarget;
    const anio = Number(container.querySelector("#sel-anio").value);
    $btn.disabled = true;
    const antes = $btn.textContent;
    $btn.textContent = "Generando…";
    try {
      const formato = $btn.dataset.exportar;
      const mod = await import(formato === "pdf" ? "../utils/exportar-pdf.js" : "../utils/exportar-excel.js");
      const generar = formato === "pdf" ? mod.exportarGastosPdf : mod.exportarGastosExcel;
      await generar({ anio, gastos });
      toastOk(`${formato === "pdf" ? "PDF" : "Excel"} de gastos ${anio} descargado.`);
    } catch (err) {
      toastError(err.message || "No se ha podido generar el Excel.");
    } finally {
      $btn.disabled = false;
      $btn.textContent = antes;
    }
  };
  container.querySelectorAll("[data-exportar]").forEach($b => $b.addEventListener("click", exportar));

  container.querySelector("#sel-anio").addEventListener("change", () => pintar());

  let categoriaFiltro = "";
  let deducibleFiltro = ""; // "" | "si" | "no"

  container.querySelectorAll("#seg-deducible button").forEach(btn => {
    btn.addEventListener("click", () => {
      deducibleFiltro = btn.dataset.val;
      container.querySelectorAll("#seg-deducible button").forEach(b => b.classList.toggle("active", b === btn));
      pintar();
    });
  });

  pintar();

  function pintar() {
    const anio = Number(container.querySelector("#sel-anio").value);
    let lista = (gastos || []).filter(g => new Date(g.fecha).getFullYear() === anio);
    if (categoriaFiltro) lista = lista.filter(g => g.categoria === categoriaFiltro);
    if (deducibleFiltro === "si") lista = lista.filter(g => g.deducible !== false);
    if (deducibleFiltro === "no") lista = lista.filter(g => g.deducible === false);

    const deducibles = lista.filter(g => g.deducible !== false);
    const noDeducibles = lista.filter(g => g.deducible === false);

    // --- Totales ---
    // Estas cifras NO tienen por qué sumar entre sí, y antes se mostraban una
    // al lado de otra sin explicación, invitando a sumarlas y a pensar que algo
    // fallaba: "Total gastado" es dinero que sale de la cuenta (con IVA
    // incluido), mientras que "Base deducible" descuenta el IVA que sí se
    // recupera y reparte las amortizaciones a lo largo de varios años. Ahora
    // cada tarjeta lleva debajo qué significa.
    const hoy = todayIso();
    const desdeAnio = `${anio}-01-01`;
    const hastaAnio = `${anio}-12-31`;

    // Los gastos fijos (cuota de autónomo, gestoría) se dan de alta por
    // adelantado hasta diciembre, así que el año contiene gasto que todavía no
    // ha salido de la cuenta. Se separa lo ya pagado de lo previsto para no
    // dar por gastado lo que aún no lo está.
    const yaPagados = lista.filter(g => (g.fecha || "") <= hoy);
    const previstos = lista.filter(g => (g.fecha || "") > hoy);
    const totalPagado = round2(yaPagados.reduce((s,g)=>s+Number(g.importe||0),0));
    const totalPrevisto = round2(previstos.reduce((s,g)=>s+Number(g.importe||0),0));
    const totalImporte = round2(totalPagado + totalPrevisto);

    // Base deducible: se calcula con la MISMA función que usa Financiero
    // (sumaGastosDeduciblesEnRango, que prorratea amortizaciones dentro del
    // rango) y sobre la lista COMPLETA de gastos, no solo los fechados en este
    // año — un bien comprado en un ejercicio anterior sigue generando cuota
    // deducible en este. Antes esta pantalla usaba gastoDeducibleTotal() y
    // daba 3.320,02 € donde Financiero decía 3.360,45 €, con la misma etiqueta.
    const deduciblesParaBase = (gastos || []).filter(g => {
      if (g.deducible === false) return false;
      if (categoriaFiltro && (g.categoria || "otros") !== categoriaFiltro) return false;
      return true;
    });
    const totalDeducible = deducibleFiltro === "no"
      ? 0
      : sumaGastosDeduciblesEnRango(deduciblesParaBase, desdeAnio, hastaAnio);
    const totalNoDeducible = round2(noDeducibles.reduce((s,g)=>s+Number(g.importe||0),0));
    const totalIvaNoDeducible = round2(deducibles.reduce((s,g)=>{
      const ivaSoportado = Number(g.iva_soportado||0);
      const pct = Number(g.iva_deducible_pct ?? 100);
      return s + round2(ivaSoportado * (1 - pct/100));
    },0));
    const amortizablesActivos = lista.filter(g => g.es_amortizable);

    container.querySelector("#gastos-resumen").innerHTML = `
      <div class="card kpi">
        <div class="label">Pagado en ${anio}</div>
        <div class="value">${eur(totalPagado)}</div>
        <div class="stat-note">${totalPrevisto ? `+ ${eur(totalPrevisto)} ya previsto hasta diciembre` : "salida real de caja, IVA incluido"}</div>
      </div>
      <div class="card kpi">
        <div class="label">Base deducible ${anio}</div>
        <div class="value pos">${eur(totalDeducible)}</div>
        <div class="stat-note">lo que resta en el Modelo 130</div>
      </div>
      <div class="card kpi">
        <div class="label">No deducible</div>
        <div class="value" style="color:var(--orange-fg)">${eur(totalNoDeducible)}</div>
        <div class="stat-note">coste real, pero no ante Hacienda</div>
      </div>
      <div class="card kpi dark">
        <div class="label">IVA no recuperable</div>
        <div class="value">${eur(totalIvaNoDeducible)}</div>
        <div class="stat-note">${amortizablesActivos.length} bien(es) amortizándose</div>
      </div>
    `;

    // --- Chips por categoría ---
    const porCategoria = {};
    lista.forEach(g => {
      const k = g.categoria || "otros";
      (porCategoria[k] ||= { total: 0, count: 0 }).total = round2(porCategoria[k].total + Number(g.importe||0));
      porCategoria[k].count++;
    });
    const $chips = container.querySelector("#categorias-chips");
    const entradas = Object.entries(porCategoria).sort((a,b) => b[1].total - a[1].total);
    $chips.innerHTML = `
      <button class="chip-cat ${categoriaFiltro===""?"active":""}" data-cat="" style="background:${categoriaFiltro===""?"var(--navy)":"var(--light)"}; color:${categoriaFiltro===""?"#fff":"var(--text)"};">Todas · ${eur(totalImporte)}</button>
      ${entradas.map(([k,v]) => {
        const cat = CATEGORIAS_GASTO[k] || CATEGORIAS_GASTO.otros;
        const activo = categoriaFiltro === k;
        return `<button class="chip-cat" data-cat="${k}" style="background:${activo?cat.fg:cat.bg}; color:${activo?"#fff":cat.fg};">${cat.label} · ${eur(v.total)} <span style="opacity:.7">(${v.count})</span></button>`;
      }).join("") || `<p class="muted" style="font-size:12px;">Sin gastos en este filtro.</p>`}
    `;
    $chips.querySelectorAll(".chip-cat").forEach(btn => {
      btn.addEventListener("click", () => { categoriaFiltro = btn.dataset.cat; pintar(); });
    });

    // --- Gráfica doughnut ---
    const ctx = container.querySelector("#chart-categorias");
    if (ctx && window.Chart) {
      if (chartCategorias) { chartCategorias.destroy(); chartCategorias = null; }
      const labels = entradas.map(([k]) => (CATEGORIAS_GASTO[k]||CATEGORIAS_GASTO.otros).label);
      const data = entradas.map(([,v]) => v.total);
      const colors = entradas.map(([k]) => (CATEGORIAS_GASTO[k]||CATEGORIAS_GASTO.otros).fg);
      chartCategorias = new window.Chart(ctx, {
        type: "doughnut",
        data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0, spacing: 3, hoverOffset: 8 }] },
        options: opcionesDoughnut(eur, { leyenda: "right" }),
      });
    }

    // --- Listado agrupado por mes (accordion) ---
    const $meses = container.querySelector("#gastos-meses");
    const mesActualIdx = new Date().getMonth();
    $meses.innerHTML = MESES.map((nombreMes, idx) => {
      const delMes = lista.filter(g => new Date(g.fecha).getMonth() === idx)
        .sort((a,b) => (a.fecha < b.fecha ? 1 : -1));
      const totalMes = round2(delMes.reduce((s,g)=>s+Number(g.importe||0),0));
      if (!delMes.length) return "";
      // Mes que aún no ha llegado: lleva gasto fijo dado de alta por
      // adelantado, así que se marca como previsto y se atenúa para que no se
      // confunda con dinero ya salido de la cuenta.
      const esFuturo = anio > anioActual || (anio === anioActual && idx > mesActualIdx);
      // Misma estructura de cabecera que Facturación mensual: nombre e importe
      // en columnas de ancho fijo, para que los meses queden alineados.
      return `
      <details class="card${esFuturo ? " proyectado" : ""}" style="margin-bottom:10px;" ${idx === mesActualIdx && anio === anioActual ? "open" : ""}>
        <summary>
          <span class="mes-nombre">${nombreMes}</span>
          <span class="mes-total">${eur(totalMes)}</span>
          <span class="mes-meta">${delMes.length} gasto${delMes.length===1?"":"s"}</span>
          ${esFuturo ? `<span class="mes-accion"><span class="badge badge-proyectado">Previsto</span></span>` : ""}
        </summary>
        <table style="margin-top:10px;">
          <thead><tr><th>Fecha</th><th>Concepto</th><th>Categoría</th><th>Pago</th><th class="money">Importe</th><th>Deducible</th></tr></thead>
          <tbody>
            ${delMes.map(g => {
              const cat = CATEGORIAS_GASTO[g.categoria] || CATEGORIAS_GASTO.otros;
              const esDeducible = g.deducible !== false;
              const conFactura = g.con_factura !== false;
              const amortNota = g.es_amortizable ? `<span class="subnote">Amortizando · ${g.meses_amortizacion} meses desde ${dateEs(g.fecha_inicio_amortizacion || g.fecha)}</span>` : "";
              return `<tr class="clickable" data-id="${g.id}">
                <td>${dateEs(g.fecha)}</td>
                <td>${escapeHtml(g.concepto)}${amortNota}</td>
                <td><span class="badge" style="background:${cat.bg};color:${cat.fg}">${cat.label}</span></td>
                <td><span class="badge" style="background:${conFactura?"var(--purple-bg)":"var(--grey-bg)"};color:${conFactura?"var(--purple-fg)":"var(--grey-fg)"}">${conFactura?"Factura":"Efectivo"}</span></td>
                <td class="money">${eur(g.importe)}</td>
                <td><span class="badge" style="background:${esDeducible?"var(--green-bg)":"var(--orange-bg)"};color:${esDeducible?"var(--green-fg)":"var(--orange-fg)"}">${esDeducible?"Sí":"No"}</span></td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </details>`;
    }).join("") || `<div class="empty-state">Sin gastos en este filtro.<br><button class="btn btn-primary" id="btn-nuevo-gasto-vacio">+ Añadir gasto</button></div>`;

    $meses.querySelector("#btn-nuevo-gasto-vacio")?.addEventListener("click", () => abrirFormulario(container, null, () => renderGastos(container)));

    $meses.querySelectorAll("tr[data-id]").forEach(tr => {
      tr.addEventListener("click", () => {
        const gasto = gastos.find(g => g.id === tr.dataset.id);
        abrirFormulario(container, gasto, () => renderGastos(container));
      });
    });

    animarVista(container);
  }
}

function abrirFormulario(container, gasto, onGuardado) {
  const esNuevo = !gasto;
  gasto = gasto || {
    concepto: "", importe: 0, tipo: "variable", fecha: todayIso(), recurrente: false,
    categoria: "otros", deducible: true, con_factura: true, iva_soportado: 0, iva_deducible_pct: 100,
    es_amortizable: false, tipo_bien: null, meses_amortizacion: null, fecha_inicio_amortizacion: todayIso(),
  };
  // El formulario va en un diálogo, no empotrado en la página: antes se
  // insertaba encima del listado y empujaba todo hacia abajo, así que había
  // que hacer scroll para ver a la vez lo que escribías y el total.
  const $wrap = document.createElement("div");
  $wrap.className = "modal-backdrop";
  document.body.appendChild($wrap);
  const alPulsarEsc = e => { if (e.key === "Escape") cerrarFormulario(); };
  function cerrarFormulario() {
    $wrap.remove();
    document.removeEventListener("keydown", alPulsarEsc);
  }
  document.addEventListener("keydown", alPulsarEsc);
  $wrap.addEventListener("mousedown", e => { if (e.target === $wrap) cerrarFormulario(); });

  $wrap.innerHTML = `
    <div class="modal ancho" role="dialog" aria-modal="true">
      <div class="card-head"><h3>${esNuevo ? "Nuevo gasto" : "Editar gasto"}</h3></div>
      <div class="row">
        <div class="field" style="flex:2"><label>Concepto</label><input id="g-concepto" value="${escapeAttr(gasto.concepto)}"></div>
        <div class="field"><label>Fecha</label><input id="g-fecha" type="date" value="${gasto.fecha}"></div>
      </div>
      <div class="row">
        <div class="field"><label>Categoría fiscal</label>
          <select id="g-categoria">
            ${Object.entries(CATEGORIAS_GASTO).map(([k,v]) => `<option value="${k}" ${k===gasto.categoria?"selected":""}>${v.label}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Tipo (flujo de caja)</label>
          <select id="g-tipo"><option value="variable" ${gasto.tipo==="variable"?"selected":""}>Variable</option><option value="fijo" ${gasto.tipo==="fijo"?"selected":""}>Fijo</option></select>
        </div>
      </div>

      <div class="toggle-box">
        <label><input type="checkbox" id="g-con-factura" ${gasto.con_factura !== false ? "checked" : ""}> Con factura</label>
        <div class="hint-box" id="g-hint-efectivo" style="display:none;">Pago en efectivo o sin factura: no se desglosa IVA (no se puede recuperar sin factura) y por defecto no cuenta como deducible en Hacienda.</div>
      </div>

      <div class="toggle-box">
        <label><input type="checkbox" id="g-deducible" ${gasto.deducible !== false ? "checked" : ""}> Deducible en Hacienda (IRPF / Modelo 130)</label>
        <div class="hint-box" id="g-hint-no-deducible" style="display:none;">Restará en tu balance real (personal) pero no se declara a Hacienda — útil para pagos en efectivo sin ticket u otros gastos no justificables fiscalmente.</div>
      </div>

      <div id="g-importe-wrap"></div>

      <div id="g-iva-wrap" class="row">
        <div class="field"><label>IVA soportado (€, automático)</label><input id="g-iva-soportado" type="number" step="0.01" value="${gasto.iva_soportado}" readonly style="background:var(--light);"></div>
        <div class="field"><label>% IVA deducible</label><input id="g-iva-pct" type="number" step="1" value="${gasto.iva_deducible_pct}"></div>
      </div>
      <div class="hint-box" id="g-hint-combustible" style="display:none;">Combustible: por defecto solo el 50% del IVA es deducible (uso mixto del vehículo). Ajústalo si tu caso es distinto.</div>

      <div id="g-amort-wrap"></div>

      <div id="g-totales" style="margin:12px 0; font-size:14px;"></div>

      <div class="form-actions">
        <button class="btn btn-primary" id="btn-guardar-gasto">Guardar</button>
        <button class="btn btn-ghost" id="btn-cancelar-gasto">Cancelar</button>
        ${esNuevo ? "" : `<button class="btn btn-danger" id="btn-borrar-gasto" style="margin-left:auto;">Eliminar</button>`}
      </div>
    </div>`;

  function pintarAmortizacion() {
    const categoria = $wrap.querySelector("#g-categoria").value;
    const importe = Number($wrap.querySelector("#g-importe").value || 0);
    const esMaterialAmortizable = categoria === "material_amortizable" && $wrap.querySelector("#g-deducible").checked;
    const $amort = $wrap.querySelector("#g-amort-wrap");
    if (!esMaterialAmortizable) { $amort.innerHTML = ""; return; }

    if (importe <= UMBRAL_AMORTIZACION) {
      $amort.innerHTML = `<p class="muted" style="font-size:12px;">Por debajo de ${eur(UMBRAL_AMORTIZACION)}: se deduce de golpe, no hace falta amortizar.</p>`;
      return;
    }
    const tipoBien = gasto.tipo_bien || "equipo_audiovisual_informatico";
    $amort.innerHTML = `
      <div class="row">
        <div class="field"><label>Tipo de bien (tabla de amortización)</label>
          <select id="g-tipo-bien">
            ${Object.entries(TABLA_AMORTIZACION).map(([k,v]) => `<option value="${k}" ${k===tipoBien?"selected":""}>${v.label} (${v.coeficienteAnual}%/año)</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Inicio amortización</label><input id="g-fecha-inicio-amort" type="date" value="${gasto.fecha_inicio_amortizacion || gasto.fecha}"></div>
        <div class="field"><label>Cuota mensual</label><input id="g-cuota-mensual" disabled></div>
      </div>`;
    const actualizarCuota = () => {
      const tb = $wrap.querySelector("#g-tipo-bien").value;
      const meses = mesesPorTipoBien(tb);
      const deducible = gastoDeducibleTotal({ importe, iva_soportado: Number($wrap.querySelector("#g-iva-soportado").value||0), iva_deducible_pct: Number($wrap.querySelector("#g-iva-pct").value||100) });
      $wrap.querySelector("#g-cuota-mensual").value = `${eur(round2(deducible/meses))} / mes durante ${meses} meses`;
    };
    $wrap.querySelector("#g-tipo-bien").addEventListener("change", actualizarCuota);
    actualizarCuota();
  }

  function actualizarTotales() {
    const conFactura = $wrap.querySelector("#g-con-factura").checked;
    const esDeducible = $wrap.querySelector("#g-deducible").checked;
    const importe = Number($wrap.querySelector("#g-importe")?.value || 0);
    const ivaSoportado = conFactura ? Number($wrap.querySelector("#g-iva-soportado")?.value || 0) : 0;
    const pct = Number($wrap.querySelector("#g-iva-pct")?.value || 100);
    $wrap.querySelector("#g-hint-no-deducible").style.display = esDeducible ? "none" : "flex";
    $wrap.querySelector("#g-iva-wrap").style.display = (esDeducible && conFactura) ? "flex" : "none";
    if (esDeducible) {
      const deducible = gastoDeducibleTotal({ importe, iva_soportado: ivaSoportado, iva_deducible_pct: pct });
      $wrap.querySelector("#g-totales").innerHTML = conFactura
        ? `Deducible a efectos de IRPF: <strong style="color:var(--green-fg)">${eur(deducible)}</strong> · IVA no recuperable (coste real): <strong>${eur(round2(ivaSoportado*(1-pct/100)))}</strong>`
        : `Deducible a efectos de IRPF: <strong style="color:var(--green-fg)">${eur(importe)}</strong> (sin factura, no hay IVA que desglosar).`;
    } else {
      $wrap.querySelector("#g-totales").innerHTML = `Gasto personal: <strong style="color:var(--orange-fg)">${eur(importe)}</strong> — no cuenta para Hacienda, solo para tu balance real.`;
    }
    pintarAmortizacion();
  }

  function pintarImporte() {
    const conFactura = $wrap.querySelector("#g-con-factura").checked;
    const esDeducible = $wrap.querySelector("#g-deducible").checked;
    const $imp = $wrap.querySelector("#g-importe-wrap");
    const mostrarDesglose = conFactura && esDeducible;

    if (mostrarDesglose) {
      const ivaSoportadoActual = Number(gasto.iva_soportado || 0);
      const importeActual = Number(gasto.importe || 0);
      const baseInicial = round2(importeActual - ivaSoportadoActual) || 0;
      const ivaTipoInicial = (ivaSoportadoActual > 0 && baseInicial) ? Math.round((ivaSoportadoActual / baseInicial) * 100) : 21;
      $imp.innerHTML = `
        <div class="row">
          <div class="field"><label>Base imponible (€, sin IVA)</label><input id="g-base" type="number" step="0.01" value="${baseInicial || ""}"></div>
          <div class="field"><label>% IVA</label><input id="g-iva-tipo" type="number" step="1" value="${ivaTipoInicial}"></div>
          <div class="field"><label>Total (€, con IVA)</label><input id="g-importe" type="number" step="0.01" value="${gasto.importe}" readonly style="background:var(--light); font-weight:600;"></div>
        </div>`;
      const recalcular = () => {
        const base = Number($wrap.querySelector("#g-base").value || 0);
        const ivaTipo = Number($wrap.querySelector("#g-iva-tipo").value || 0);
        const iva = round2(base * (ivaTipo / 100));
        $wrap.querySelector("#g-iva-soportado").value = iva;
        $wrap.querySelector("#g-importe").value = round2(base + iva);
        actualizarTotales();
      };
      $wrap.querySelector("#g-base").addEventListener("input", recalcular);
      $wrap.querySelector("#g-iva-tipo").addEventListener("input", recalcular);
      recalcular();
    } else {
      $imp.innerHTML = `
        <div class="row">
          <div class="field"><label>Importe (€)${conFactura ? "" : " — pago en efectivo, sin IVA"}</label><input id="g-importe" type="number" step="0.01" value="${gasto.importe}"></div>
        </div>`;
      $wrap.querySelector("#g-iva-soportado").value = 0;
      $wrap.querySelector("#g-importe").addEventListener("input", actualizarTotales);
      actualizarTotales();
    }
  }

  $wrap.querySelector("#g-deducible").addEventListener("change", pintarImporte);
  $wrap.querySelector("#g-con-factura").addEventListener("change", () => {
    const conFactura = $wrap.querySelector("#g-con-factura").checked;
    $wrap.querySelector("#g-hint-efectivo").style.display = conFactura ? "none" : "flex";
    if (esNuevo) $wrap.querySelector("#g-deducible").checked = conFactura; // sugerencia de defecto, editable
    pintarImporte();
  });
  $wrap.querySelector("#g-categoria").addEventListener("change", () => {
    const categoria = $wrap.querySelector("#g-categoria").value;
    const defecto = CATEGORIAS_GASTO[categoria]?.ivaDeduciblePctDefecto ?? 100;
    $wrap.querySelector("#g-iva-pct").value = defecto;
    $wrap.querySelector("#g-hint-combustible").style.display = categoria === "combustible" ? "flex" : "none";
    actualizarTotales();
  });
  $wrap.querySelector("#g-iva-pct").addEventListener("input", actualizarTotales);
  $wrap.querySelector("#g-hint-combustible").style.display = gasto.categoria === "combustible" ? "flex" : "none";
  $wrap.querySelector("#g-hint-efectivo").style.display = gasto.con_factura !== false ? "none" : "flex";
  pintarImporte();

  $wrap.querySelector("#btn-cancelar-gasto").addEventListener("click", cerrarFormulario);

  $wrap.querySelector("#btn-guardar-gasto").addEventListener("click", async () => {
    const categoria = $wrap.querySelector("#g-categoria").value;
    const importe = Number($wrap.querySelector("#g-importe").value || 0);
    const esDeducible = $wrap.querySelector("#g-deducible").checked;
    const conFactura = $wrap.querySelector("#g-con-factura").checked;
    const esMaterialAmortizable = esDeducible && categoria === "material_amortizable" && importe > UMBRAL_AMORTIZACION;
    const tipoBien = esMaterialAmortizable ? ($wrap.querySelector("#g-tipo-bien")?.value || "equipo_audiovisual_informatico") : null;
    const payload = {
      concepto: $wrap.querySelector("#g-concepto").value.trim(),
      importe,
      tipo: $wrap.querySelector("#g-tipo").value,
      fecha: $wrap.querySelector("#g-fecha").value || todayIso(),
      categoria,
      deducible: esDeducible,
      con_factura: conFactura,
      iva_soportado: (esDeducible && conFactura) ? Number($wrap.querySelector("#g-iva-soportado").value || 0) : 0,
      iva_deducible_pct: (esDeducible && conFactura) ? Number($wrap.querySelector("#g-iva-pct").value || 100) : 0,
      es_amortizable: esMaterialAmortizable,
      tipo_bien: tipoBien,
      meses_amortizacion: esMaterialAmortizable ? mesesPorTipoBien(tipoBien) : null,
      fecha_inicio_amortizacion: esMaterialAmortizable ? ($wrap.querySelector("#g-fecha-inicio-amort")?.value || $wrap.querySelector("#g-fecha").value) : null,
    };
    if (!payload.concepto) { toastError("Falta el concepto del gasto."); $wrap.querySelector("#g-concepto").focus(); return; }
    const { error } = esNuevo
      ? await db.from("gastos").insert(payload).exec()
      : await db.from("gastos").update(payload).eq("id", gasto.id).exec();
    if (error) { toastError("No se ha podido guardar: " + error); return; }
    toastOk(esNuevo ? `Gasto "${payload.concepto}" añadido.` : "Gasto actualizado.");
    cerrarFormulario();
    onGuardado();
  });

  if (!esNuevo) {
    $wrap.querySelector("#btn-borrar-gasto").addEventListener("click", async () => {
      if (!await confirmarBorrado(`el gasto "${gasto.concepto}"`)) return;
      const { error } = await db.from("gastos").delete().eq("id", gasto.id).exec();
      if (error) { toastError("No se ha podido eliminar: " + error); return; }
      toastOk("Gasto eliminado.");
      cerrarFormulario();
    onGuardado();
    });
  }

  $wrap.scrollIntoView({ behavior: "smooth", block: "start" });
}
