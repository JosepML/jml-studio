import { db } from "../supabase.js";
import { eur, dateEs, todayIso, CATEGORIAS_GASTO } from "../utils/format.js";
import { gastoDeducibleTotal, round2 } from "../utils/invoice-calc.js";
import { TABLA_AMORTIZACION, mesesPorTipoBien, UMBRAL_AMORTIZACION } from "../utils/amortizacion.js";
import { escapeHtml, escapeAttr } from "./clientes.js";

const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
let chartCategorias = null;

export async function renderGastos(container) {
  container.innerHTML = `<div class="empty-state">Cargando gastos…</div>`;

  const { data: gastos, error } = await db.from("gastos").select("*").order("fecha", { ascending: false }).exec();
  if (error) { container.innerHTML = `<p class="muted">Error cargando gastos: ${error}</p>`; return; }

  const anioActual = new Date().getFullYear();
  const anios = Array.from(new Set([...(gastos || []).map(g => new Date(g.fecha).getFullYear()), anioActual])).sort((a,b)=>b-a);

  container.innerHTML = `
    <div style="display:flex; justify-content:space-between; margin-bottom:14px; gap:8px; align-items:center; flex-wrap:wrap;">
      <button class="btn btn-primary" id="btn-nuevo-gasto">+ Añadir gasto</button>
      <div style="display:flex; gap:8px; align-items:center;">
        <label style="margin:0;">Año</label>
        <select id="sel-anio" style="width:auto;">${anios.map(a => `<option value="${a}" ${a===anioActual?"selected":""}>${a}</option>`).join("")}</select>
      </div>
    </div>
    <div id="gasto-form-wrap"></div>
    <div id="gastos-resumen" class="grid grid-4" style="margin-bottom:20px;"></div>
    <div class="grid grid-2" style="margin-bottom:20px;">
      <div class="card">
        <h3>Por categoría</h3>
        <div id="categorias-chips" style="display:flex; flex-wrap:wrap; gap:8px;"></div>
      </div>
      <div class="card">
        <h3>Reparto del gasto</h3>
        <div style="position:relative; height:180px;"><canvas id="chart-categorias"></canvas></div>
      </div>
    </div>
    <div id="gastos-meses"></div>
  `;

  container.querySelector("#btn-nuevo-gasto").addEventListener("click", () => abrirFormulario(container, null, () => renderGastos(container)));
  container.querySelector("#sel-anio").addEventListener("change", () => pintar());

  let categoriaFiltro = "";
  pintar();

  function pintar() {
    const anio = Number(container.querySelector("#sel-anio").value);
    let lista = (gastos || []).filter(g => new Date(g.fecha).getFullYear() === anio);
    if (categoriaFiltro) lista = lista.filter(g => g.categoria === categoriaFiltro);

    const deducibles = lista.filter(g => g.deducible !== false);
    const noDeducibles = lista.filter(g => g.deducible === false);

    const totalImporte = round2(lista.reduce((s,g)=>s+Number(g.importe||0),0));
    const totalDeducible = round2(deducibles.reduce((s,g)=> s + gastoDeducibleTotal(g), 0));
    const totalNoDeducible = round2(noDeducibles.reduce((s,g)=>s+Number(g.importe||0),0));
    const totalIvaNoDeducible = round2(deducibles.reduce((s,g)=>{
      const ivaSoportado = Number(g.iva_soportado||0);
      const pct = Number(g.iva_deducible_pct ?? 100);
      return s + round2(ivaSoportado * (1 - pct/100));
    },0));
    const amortizablesActivos = lista.filter(g => g.es_amortizable);

    container.querySelector("#gastos-resumen").innerHTML = `
      <div class="card kpi"><div class="label">Total gastado ${anio}</div><div class="value">${eur(totalImporte)}</div></div>
      <div class="card kpi"><div class="label">Deducible IRPF (Hacienda)</div><div class="value" style="color:var(--green-fg)">${eur(totalDeducible)}</div></div>
      <div class="card kpi"><div class="label">No deducible (personal)</div><div class="value" style="color:var(--orange-fg)">${eur(totalNoDeducible)}</div></div>
      <div class="card kpi dark"><div class="label">IVA no recuperable</div><div class="value">${eur(totalIvaNoDeducible)}</div><div style="font-size:11px;color:#B9C0DA;">${amortizablesActivos.length} bien(es) en amortización</div></div>
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
      }).join("") || `<p class="muted" style="font-size:12px;">Sin gastos este año.</p>`}
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
        data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0 }] },
        options: {
          maintainAspectRatio: false,
          plugins: { legend: { position: "right", labels: { boxWidth: 10, font: { size: 11 } } } },
        },
      });
    }

    // --- Listado agrupado por mes (accordion, igual que Facturación mensual) ---
    const $meses = container.querySelector("#gastos-meses");
    $meses.innerHTML = MESES.map((nombreMes, idx) => {
      const delMes = lista.filter(g => new Date(g.fecha).getMonth() === idx)
        .sort((a,b) => (a.fecha < b.fecha ? 1 : -1));
      const totalMes = round2(delMes.reduce((s,g)=>s+Number(g.importe||0),0));
      if (!delMes.length) return "";
      return `
      <details class="card" style="margin-bottom:10px;" ${idx === new Date().getMonth() && anio === anioActual ? "open" : ""}>
        <summary style="cursor:pointer; font-weight:600;">${nombreMes} — ${eur(totalMes)} <span class="muted" style="font-weight:400;">(${delMes.length} gasto${delMes.length===1?"":"s"})</span></summary>
        <table style="margin-top:10px;">
          <thead><tr><th>Fecha</th><th>Concepto</th><th>Categoría</th><th>Pago</th><th>Importe</th><th>Deducible</th><th>Amortización</th></tr></thead>
          <tbody>
            ${delMes.map(g => {
              const cat = CATEGORIAS_GASTO[g.categoria] || CATEGORIAS_GASTO.otros;
              const esDeducible = g.deducible !== false;
              const conFactura = g.con_factura !== false;
              const amort = g.es_amortizable ? `${g.meses_amortizacion} meses desde ${dateEs(g.fecha_inicio_amortizacion || g.fecha)}` : "—";
              return `<tr class="clickable" data-id="${g.id}">
                <td>${dateEs(g.fecha)}</td>
                <td>${escapeHtml(g.concepto)}</td>
                <td><span class="badge" style="background:${cat.bg};color:${cat.fg}">${cat.label}</span></td>
                <td><span class="badge" style="background:${conFactura?"var(--purple-bg)":"var(--grey-bg)"};color:${conFactura?"var(--purple-fg)":"var(--grey-fg)"}">${conFactura?"Factura":"Efectivo"}</span></td>
                <td>${eur(g.importe)}</td>
                <td><span class="badge" style="background:${esDeducible?"var(--green-bg)":"var(--orange-bg)"};color:${esDeducible?"var(--green-fg)":"var(--orange-fg)"}">${esDeducible?"Sí":"No"}</span></td>
                <td style="font-size:12px;">${amort}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </details>`;
    }).join("") || `<div class="empty-state">Sin gastos en este filtro.</div>`;

    $meses.querySelectorAll("tr[data-id]").forEach(tr => {
      tr.addEventListener("click", () => {
        const gasto = gastos.find(g => g.id === tr.dataset.id);
        abrirFormulario(container, gasto, () => renderGastos(container));
      });
    });
  }
}

function abrirFormulario(container, gasto, onGuardado) {
  const esNuevo = !gasto;
  gasto = gasto || {
    concepto: "", importe: 0, tipo: "variable", fecha: todayIso(), recurrente: false,
    categoria: "otros", deducible: true, con_factura: true, iva_soportado: 0, iva_deducible_pct: 100,
    es_amortizable: false, tipo_bien: null, meses_amortizacion: null, fecha_inicio_amortizacion: todayIso(),
  };
  const $wrap = container.querySelector("#gasto-form-wrap");

  $wrap.innerHTML = `
    <div class="card" style="margin-bottom:14px;">
      <h3>${esNuevo ? "Nuevo gasto" : "Editar gasto"}</h3>
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

      <div class="field" style="background:var(--light); border-radius:8px; padding:10px 12px; margin-bottom:14px;">
        <label style="display:flex; align-items:center; gap:8px; text-transform:none; font-size:13px; color:var(--text);">
          <input type="checkbox" id="g-con-factura" style="width:auto;" ${gasto.con_factura !== false ? "checked" : ""}>
          Con factura
        </label>
        <p class="muted" id="g-hint-efectivo" style="display:none; font-size:12px; margin:6px 0 0;">Pago en efectivo o sin factura: el sistema no desglosa IVA (no se puede recuperar sin factura) y por defecto no cuenta como deducible en Hacienda.</p>
      </div>

      <div class="field" style="background:var(--light); border-radius:8px; padding:10px 12px; margin-bottom:14px;">
        <label style="display:flex; align-items:center; gap:8px; text-transform:none; font-size:13px; color:var(--text);">
          <input type="checkbox" id="g-deducible" style="width:auto;" ${gasto.deducible !== false ? "checked" : ""}>
          Deducible en Hacienda (cuenta para IRPF / Modelo 130)
        </label>
        <p class="muted" id="g-hint-no-deducible" style="display:none; font-size:12px; margin:6px 0 0;">Este gasto restará en tu balance real (personal) pero no se declara a Hacienda — útil para pagos en efectivo sin ticket u otros gastos que no puedes justificar fiscalmente.</p>
      </div>

      <div id="g-importe-wrap"></div>

      <div id="g-iva-wrap" class="row">
        <div class="field"><label>IVA soportado (€, automático)</label><input id="g-iva-soportado" type="number" step="0.01" value="${gasto.iva_soportado}" readonly style="background:var(--light);"></div>
        <div class="field"><label>% IVA deducible</label><input id="g-iva-pct" type="number" step="1" value="${gasto.iva_deducible_pct}"></div>
      </div>
      <p class="muted" id="g-hint-combustible" style="display:none; font-size:12px;">Combustible: por defecto solo el 50% del IVA es deducible (uso mixto del vehículo). Puedes ajustarlo si tu caso es distinto.</p>

      <div id="g-amort-wrap"></div>

      <div id="g-totales" style="margin:12px 0; font-size:14px;"></div>

      <div style="display:flex; gap:10px;">
        <button class="btn btn-primary" id="btn-guardar-gasto">Guardar</button>
        ${esNuevo ? "" : `<button class="btn btn-ghost" id="btn-borrar-gasto">Eliminar</button>`}
        <button class="btn btn-ghost" id="btn-cancelar-gasto">Cancelar</button>
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
    $wrap.querySelector("#g-hint-no-deducible").style.display = esDeducible ? "none" : "block";
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
    $wrap.querySelector("#g-hint-efectivo").style.display = conFactura ? "none" : "block";
    if (esNuevo) $wrap.querySelector("#g-deducible").checked = conFactura; // sugerencia de defecto, editable
    pintarImporte();
  });
  $wrap.querySelector("#g-categoria").addEventListener("change", () => {
    const categoria = $wrap.querySelector("#g-categoria").value;
    const defecto = CATEGORIAS_GASTO[categoria]?.ivaDeduciblePctDefecto ?? 100;
    $wrap.querySelector("#g-iva-pct").value = defecto;
    $wrap.querySelector("#g-hint-combustible").style.display = categoria === "combustible" ? "block" : "none";
    actualizarTotales();
  });
  $wrap.querySelector("#g-iva-pct").addEventListener("input", actualizarTotales);
  $wrap.querySelector("#g-hint-combustible").style.display = gasto.categoria === "combustible" ? "block" : "none";
  $wrap.querySelector("#g-hint-efectivo").style.display = gasto.con_factura !== false ? "none" : "block";
  pintarImporte();

  $wrap.querySelector("#btn-cancelar-gasto").addEventListener("click", () => { $wrap.innerHTML = ""; });

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
    if (!payload.concepto) { alert("Falta el concepto del gasto."); return; }
    const { error } = esNuevo
      ? await db.from("gastos").insert(payload).exec()
      : await db.from("gastos").update(payload).eq("id", gasto.id).exec();
    if (error) { alert("Error guardando: " + error); return; }
    onGuardado();
  });

  if (!esNuevo) {
    $wrap.querySelector("#btn-borrar-gasto").addEventListener("click", async () => {
      if (!confirm("¿Eliminar este gasto?")) return;
      const { error } = await db.from("gastos").delete().eq("id", gasto.id).exec();
      if (error) { alert("Error eliminando: " + error); return; }
      onGuardado();
    });
  }

  $wrap.scrollIntoView({ behavior: "smooth", block: "start" });
}
