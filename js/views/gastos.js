import { db } from "../supabase.js";
import { eur, dateEs, todayIso, CATEGORIAS_GASTO } from "../utils/format.js";
import { gastoDeducibleTotal, round2 } from "../utils/invoice-calc.js";
import { TABLA_AMORTIZACION, mesesPorTipoBien, UMBRAL_AMORTIZACION } from "../utils/amortizacion.js";
import { escapeHtml, escapeAttr } from "./clientes.js";

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
        <label style="margin:0;">Categoría</label>
        <select id="sel-categoria" style="width:auto;">
          <option value="">Todas</option>
          ${Object.entries(CATEGORIAS_GASTO).map(([k,v]) => `<option value="${k}">${v.label}</option>`).join("")}
        </select>
      </div>
    </div>
    <div id="gasto-form-wrap"></div>
    <div id="gastos-resumen" class="grid grid-4" style="margin-bottom:20px;"></div>
    <div class="card"><div id="gastos-table"></div></div>
  `;

  container.querySelector("#btn-nuevo-gasto").addEventListener("click", () => abrirFormulario(container, null, () => renderGastos(container)));
  container.querySelector("#sel-anio").addEventListener("change", pintar);
  container.querySelector("#sel-categoria").addEventListener("change", pintar);
  pintar();

  function pintar() {
    const anio = Number(container.querySelector("#sel-anio").value);
    const categoria = container.querySelector("#sel-categoria").value;
    let lista = (gastos || []).filter(g => new Date(g.fecha).getFullYear() === anio);
    if (categoria) lista = lista.filter(g => g.categoria === categoria);

    const totalImporte = round2(lista.reduce((s,g)=>s+Number(g.importe||0),0));
    const totalDeducible = round2(lista.reduce((s,g)=>{
      // Para amortizables solo contamos aquí el total deducible del bien (informativo);
      // el prorrateo mensual real se aplica en Financiero/Modelo 130.
      return s + gastoDeducibleTotal(g);
    },0));
    const totalIvaNoDeducible = round2(lista.reduce((s,g)=>{
      const ivaSoportado = Number(g.iva_soportado||0);
      const pct = Number(g.iva_deducible_pct ?? 100);
      return s + round2(ivaSoportado * (1 - pct/100));
    },0));
    const amortizablesActivos = lista.filter(g => g.es_amortizable);

    container.querySelector("#gastos-resumen").innerHTML = `
      <div class="card kpi"><div class="label">Total gastado ${anio}</div><div class="value">${eur(totalImporte)}</div></div>
      <div class="card kpi"><div class="label">Deducible IRPF (total bienes)</div><div class="value" style="color:var(--green-fg)">${eur(totalDeducible)}</div></div>
      <div class="card kpi"><div class="label">IVA no recuperable</div><div class="value">${eur(totalIvaNoDeducible)}</div></div>
      <div class="card kpi dark"><div class="label">Bienes en amortización</div><div class="value">${amortizablesActivos.length}</div></div>
    `;

    container.querySelector("#gastos-table").innerHTML = `
      <table>
        <thead><tr><th>Fecha</th><th>Concepto</th><th>Categoría</th><th>Importe</th><th>IVA soportado</th><th>% IVA deducible</th><th>Deducible IRPF</th><th>Amortización</th></tr></thead>
        <tbody>
          ${lista.map(g => {
            const cat = CATEGORIAS_GASTO[g.categoria] || CATEGORIAS_GASTO.otros;
            const deducible = gastoDeducibleTotal(g);
            const amort = g.es_amortizable ? `${g.meses_amortizacion} meses desde ${dateEs(g.fecha_inicio_amortizacion || g.fecha)}` : "—";
            return `<tr class="clickable" data-id="${g.id}">
              <td>${dateEs(g.fecha)}</td>
              <td>${escapeHtml(g.concepto)}</td>
              <td><span class="badge" style="background:${cat.bg};color:${cat.fg}">${cat.label}</span></td>
              <td>${eur(g.importe)}</td>
              <td>${eur(g.iva_soportado)}</td>
              <td>${g.iva_deducible_pct}%</td>
              <td>${eur(deducible)}</td>
              <td style="font-size:12px;">${amort}</td>
            </tr>`;
          }).join("") || `<tr><td colspan="8" class="muted">Sin gastos en este filtro</td></tr>`}
        </tbody>
      </table>`;

    container.querySelectorAll("#gastos-table tr[data-id]").forEach(tr => {
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
    categoria: "otros", iva_soportado: 0, iva_deducible_pct: 100,
    es_amortizable: false, tipo_bien: null, meses_amortizacion: null, fecha_inicio_amortizacion: todayIso(),
  };
  const $wrap = container.querySelector("#gasto-form-wrap");

  $wrap.innerHTML = `
    <div class="card" style="margin-bottom:14px;">
      <h3>${esNuevo ? "Nuevo gasto" : "Editar gasto"}</h3>
      <div class="row">
        <div class="field" style="flex:2"><label>Concepto</label><input id="g-concepto" value="${escapeAttr(gasto.concepto)}"></div>
        <div class="field"><label>Importe total (€, con IVA)</label><input id="g-importe" type="number" step="0.01" value="${gasto.importe}"></div>
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
        <div class="field"><label>IVA soportado (€)</label><input id="g-iva-soportado" type="number" step="0.01" value="${gasto.iva_soportado}"></div>
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
    const esMaterialAmortizable = categoria === "material_amortizable";
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
    const importe = Number($wrap.querySelector("#g-importe").value || 0);
    const ivaSoportado = Number($wrap.querySelector("#g-iva-soportado").value || 0);
    const pct = Number($wrap.querySelector("#g-iva-pct").value || 100);
    const deducible = gastoDeducibleTotal({ importe, iva_soportado: ivaSoportado, iva_deducible_pct: pct });
    $wrap.querySelector("#g-totales").innerHTML = `Deducible a efectos de IRPF: <strong style="color:var(--green-fg)">${eur(deducible)}</strong> · IVA no recuperable (coste real): <strong>${eur(round2(ivaSoportado*(1-pct/100)))}</strong>`;
    pintarAmortizacion();
  }

  $wrap.querySelector("#g-categoria").addEventListener("change", () => {
    const categoria = $wrap.querySelector("#g-categoria").value;
    const defecto = CATEGORIAS_GASTO[categoria]?.ivaDeduciblePctDefecto ?? 100;
    $wrap.querySelector("#g-iva-pct").value = defecto;
    $wrap.querySelector("#g-hint-combustible").style.display = categoria === "combustible" ? "block" : "none";
    actualizarTotales();
  });
  ["#g-importe", "#g-iva-soportado", "#g-iva-pct"].forEach(sel => $wrap.querySelector(sel).addEventListener("input", actualizarTotales));
  $wrap.querySelector("#g-hint-combustible").style.display = gasto.categoria === "combustible" ? "block" : "none";
  actualizarTotales();

  $wrap.querySelector("#btn-cancelar-gasto").addEventListener("click", () => { $wrap.innerHTML = ""; });

  $wrap.querySelector("#btn-guardar-gasto").addEventListener("click", async () => {
    const categoria = $wrap.querySelector("#g-categoria").value;
    const importe = Number($wrap.querySelector("#g-importe").value || 0);
    const esMaterialAmortizable = categoria === "material_amortizable" && importe > UMBRAL_AMORTIZACION;
    const tipoBien = esMaterialAmortizable ? ($wrap.querySelector("#g-tipo-bien")?.value || "equipo_audiovisual_informatico") : null;
    const payload = {
      concepto: $wrap.querySelector("#g-concepto").value.trim(),
      importe,
      tipo: $wrap.querySelector("#g-tipo").value,
      fecha: $wrap.querySelector("#g-fecha").value || todayIso(),
      categoria,
      iva_soportado: Number($wrap.querySelector("#g-iva-soportado").value || 0),
      iva_deducible_pct: Number($wrap.querySelector("#g-iva-pct").value || 100),
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
