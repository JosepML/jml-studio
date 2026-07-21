import { db } from "../supabase.js";
import { eur, quarterOf } from "../utils/format.js";
import { calcularModelo130, round2, PLAZOS_MODELO_130_2026 } from "../utils/invoice-calc.js";

const MESES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];

export async function renderFinanciero(container) {
  container.innerHTML = `<div class="empty-state">Cargando datos financieros…</div>`;

  const [{ data: facturas, error: e1 }, { data: gastos, error: e2 }] = await Promise.all([
    db.from("facturas").select("*").exec(),
    db.from("gastos").select("*").exec(),
  ]);
  if (e1 || e2) { container.innerHTML = `<p class="muted">Error cargando datos: ${e1 || e2}</p>`; return; }

  const anioActual = new Date().getFullYear();
  const anios = Array.from(new Set([...(facturas||[]).map(f=>new Date(f.fecha).getFullYear()), anioActual])).sort();
  let anioSeleccionado = anioActual;

  container.innerHTML = `
    <div style="display:flex; justify-content:space-between; margin-bottom:14px; gap:8px; align-items:center;">
      <button class="btn btn-ghost" id="btn-add-gasto-general">+ Añadir gasto</button>
      <div style="display:flex; gap:8px; align-items:center;">
        <label style="margin:0;">Año</label>
        <select id="sel-anio" style="width:auto;">${anios.map(a => `<option value="${a}" ${a===anioActual?"selected":""}>${a}</option>`).join("")}</select>
      </div>
    </div>
    <div id="gasto-general-form"></div>
    <div id="financiero-body"></div>`;

  container.querySelector("#sel-anio").addEventListener("change", e => pintar(Number(e.target.value)));
  container.querySelector("#btn-add-gasto-general").addEventListener("click", () => {
    const $wrap = container.querySelector("#gasto-general-form");
    $wrap.innerHTML = `
      <div class="card" style="margin-bottom:14px;">
        <div class="row" style="align-items:flex-end;">
          <div class="field"><label>Concepto</label><input id="gg-concepto" placeholder="Ej. Software, seguro, alquiler estudio..."></div>
          <div class="field"><label>Importe (€)</label><input id="gg-importe" type="number" step="0.01"></div>
          <div class="field"><label>Tipo</label><select id="gg-tipo"><option value="fijo">Fijo</option><option value="variable">Variable</option></select></div>
          <div class="field"><label>Fecha</label><input id="gg-fecha" type="date" value="${new Date().toISOString().slice(0,10)}"></div>
          <div class="field" style="flex:0"><button class="btn btn-primary" id="btn-guardar-gasto-general" type="button">Guardar</button></div>
        </div>
      </div>`;
    $wrap.querySelector("#btn-guardar-gasto-general").addEventListener("click", async () => {
      const payload = {
        concepto: $wrap.querySelector("#gg-concepto").value.trim(),
        importe: Number($wrap.querySelector("#gg-importe").value || 0),
        tipo: $wrap.querySelector("#gg-tipo").value,
        fecha: $wrap.querySelector("#gg-fecha").value,
      };
      if (!payload.concepto) { alert("Falta el concepto del gasto."); return; }
      const { error } = await db.from("gastos").insert(payload).exec();
      if (error) { alert("Error guardando: " + error); return; }
      renderFinanciero(container);
    });
  });
  pintar(anioActual);

  function pintar(anio) {
    const facturasAnio = (facturas||[]).filter(f => new Date(f.fecha).getFullYear() === anio && f.tipo === "factura");
    const gastosAnio = (gastos||[]).filter(g => new Date(g.fecha).getFullYear() === anio);

    // --- Mensual ---
    const porMes = MESES.map((_, i) => {
      const facMes = facturasAnio.filter(f => new Date(f.fecha).getMonth() === i);
      const gasMes = gastosAnio.filter(g => new Date(g.fecha).getMonth() === i);
      return {
        facturado: round2(facMes.reduce((s,f)=>s+Number(f.total||0),0)),
        gastos: round2(gasMes.reduce((s,g)=>s+Number(g.importe||0),0)),
      };
    });
    const maxFacturado = Math.max(1, ...porMes.map(m=>m.facturado));

    // --- Trimestral (Modelo 130) ---
    let acumuladoPagado = 0;
    const trimestres = [1,2,3,4].map(q => {
      const facQ = facturasAnio.filter(f => quarterOf(f.fecha) === q);
      const gasQ = gastosAnio.filter(g => quarterOf(g.fecha) === q);
      const ingresosBase = round2(facQ.reduce((s,f)=>s+Number(f.base_imponible||0),0));
      const retenciones = round2(facQ.reduce((s,f)=>s+Number(f.retencion_importe||0),0));
      const gastosQ = round2(gasQ.reduce((s,g)=>s+Number(g.importe||0),0));
      const r = calcularModelo130({ ingresosBaseTrimestre: ingresosBase, gastosTrimestre: gastosQ, retencionesSoportadasTrimestre: retenciones, pagosPreviosAnio: acumuladoPagado });
      acumuladoPagado += r.aIngresar;
      const plazo = PLAZOS_MODELO_130_2026[q-1];
      return { q, ingresosBase, gastosQ, retenciones, ...r, plazo };
    });

    // --- Anual ---
    const totalFacturado = round2(facturasAnio.reduce((s,f)=>s+Number(f.total||0),0));
    const totalBase = round2(facturasAnio.reduce((s,f)=>s+Number(f.base_imponible||0),0));
    const totalGastos = round2(gastosAnio.reduce((s,g)=>s+Number(g.importe||0),0));
    const beneficioNeto = round2(totalBase - totalGastos);

    const trimestreActual = quarterOf(new Date().toISOString().slice(0,10));
    const proximoTrimestre = trimestres[trimestreActual - 1] || trimestres[0];

    container.querySelector("#financiero-body").innerHTML = `
      <div class="grid grid-4" style="margin-bottom:20px;">
        <div class="card kpi"><div class="label">Facturado ${anio}</div><div class="value">${eur(totalFacturado)}</div></div>
        <div class="card kpi"><div class="label">Gastos ${anio}</div><div class="value">${eur(totalGastos)}</div></div>
        <div class="card kpi"><div class="label">Beneficio neto</div><div class="value" style="color:var(--green-fg)">${eur(beneficioNeto)}</div></div>
        <div class="card kpi dark"><div class="label">Próx. pago Modelo 130 (T${trimestreActual})</div><div class="value">${eur(proximoTrimestre.aIngresar)}</div><div style="font-size:11px;color:#8FD6B3;">Vence ${proximoTrimestre.plazo.fin}</div></div>
      </div>

      <div class="card" style="margin-bottom:20px;">
        <h3>Facturación mensual ${anio}</h3>
        <svg viewBox="0 0 480 160" style="width:100%; max-width:600px; height:160px;">
          ${porMes.map((m,i) => {
            const h = Math.round((m.facturado / maxFacturado) * 120);
            return `<rect x="${10 + i*38}" y="${140-h}" width="26" height="${h}" fill="#3E6FE0"></rect>
                    <text x="${23 + i*38}" y="155" font-size="9" fill="#7A8399" text-anchor="middle">${MESES[i]}</text>`;
          }).join("")}
        </svg>
      </div>

      <div class="card" style="margin-bottom:20px;">
        <h3>Modelo 130 — cierre trimestral (estimación)</h3>
        <table>
          <thead><tr><th>Trimestre</th><th>Rendimiento neto</th><th>Pago fraccionado (20%)</th><th>A ingresar</th><th>Plazo</th></tr></thead>
          <tbody>
            ${trimestres.map(t => `<tr>
              <td>T${t.q}</td><td>${eur(t.rendimientoNeto)}</td><td>${eur(t.pagoBruto)}</td>
              <td><strong>${eur(t.aIngresar)}</strong></td><td>${t.plazo.inicio.slice(8,10)}–${t.plazo.fin.slice(8,10)} ${t.plazo.fin.slice(5,7)}/${t.plazo.fin.slice(0,4)}</td>
            </tr>`).join("")}
          </tbody>
        </table>
        <p class="muted" style="font-size:12px; margin-top:10px;">Estimación orientativa (20% del rendimiento neto acumulado, menos retenciones e ingresos previos del año). Confírmalo con tu gestor/a antes de presentar el modelo oficial.</p>
      </div>
    `;
  }
}
