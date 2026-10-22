// Margen de facturación que queda en el año.
//
// Contexto (acordado con la asesoría): este año no se puede superar el SMI por
// ser el segundo año de prórroga de la cuota reducida, así que hay un tope de
// facturación adicional a lo ya emitido. Las cifras van SIN IVA (importeBase).
//
// - restante = tope − suma de lo emitido desde la fecha de corte (cuenta atrás).
// - libre    = restante − suma de los proyectos registrados aún sin emitir.
// - caben    = cuántos proyectos más entran en `libre`, estimado con el
//              importe medio de los proyectos del año.
//
// Cuándo "se emitió" cada fila: con factura real vinculada manda la fecha de la
// factura; sin ella, proyectos.fecha_emision (migración 006). Lo emitido antes
// de existir ese campo no tiene fecha y NO cuenta, que es lo que se pidió.

import { round2 } from "./invoice-calc.js";
import { estadoEfectivo, rangoAnio } from "./resumen.js";
import { eur } from "./format.js";
import { db } from "../supabase.js";

export function calcularMargen(ledger, { tope, desde, anio }) {
  const { hasta } = rangoAnio(anio);
  const filas = ledger || [];

  const emitidas = filas.filter(f =>
    estadoEfectivo(f) !== "pendiente" && f.fechaEmision && f.fechaEmision >= desde && f.fechaEmision <= hasta);
  const emitido = round2(emitidas.reduce((s, f) => s + f.importeBase, 0));

  // Registrados y sin emitir. Se ignoran los de años posteriores al actual.
  const pendientes = filas.filter(f => estadoEfectivo(f) === "pendiente" && (!f.fecha || f.fecha <= hasta));
  const pendiente = round2(pendientes.reduce((s, f) => s + f.importeBase, 0));

  const delAnio = filas.filter(f => f.fecha && f.fecha.slice(0, 4) === String(anio) && f.importeBase > 0);
  const importeMedio = delAnio.length ? round2(delAnio.reduce((s, f) => s + f.importeBase, 0) / delAnio.length) : 0;

  const restante = round2(tope - emitido);
  const libre = round2(restante - pendiente);
  const caben = libre > 0 && importeMedio > 0 ? Math.floor(libre / importeMedio) : 0;

  return { tope, desde, emitido, nEmitidos: emitidas.length, pendiente, nPendientes: pendientes.length, importeMedio, restante, libre, caben };
}

function dato(etiqueta, valor, pista) {
  const neg = valor < 0;
  // El rojo va acompañado del signo y de la palabra: no depende solo del color.
  return `<div class="card kpi"><div class="label">${etiqueta}</div>
    <div class="value ${neg ? "neg" : ""}">${eur(valor)}</div>
    ${neg ? `<div class="muted" style="font-size:12px;"><strong>Superado</strong> en ${eur(-valor)}</div>` : ""}
    <div class="muted" style="font-size:12px;">${pista}</div></div>`;
}

export function htmlMargen(m) {
  const desdeEs = m.desde.split("-").reverse().join("/");
  const caben = m.libre < 0
    ? `<div class="value neg">0</div><div class="muted" style="font-size:12px;"><strong>Sin margen</strong> para más proyectos</div>`
    : `<div class="value">${m.caben}</div><div class="muted" style="font-size:12px;">${m.importeMedio ? `Estimado con el importe medio: ${eur(m.importeMedio)}` : "Sin proyectos del año para estimar"}</div>`;
  return `<div class="card" style="margin-bottom:20px;">
    <div class="card-head"><h3>Margen de facturación del año</h3>
      <span class="help-tip" title="Tope de ${eur(m.tope)} sin IVA fijado con la asesoría (límite del SMI por la prórroga de cuota reducida), sobre lo emitido desde el ${desdeEs}. Se cambia en Configuración.">i</span></div>
    <div class="grid grid-3">
      ${dato("Margen restante", m.restante, `${eur(m.tope)} − ${eur(m.emitido)} emitido desde el ${desdeEs} (${m.nEmitidos})`)}
      ${dato("Margen libre", m.libre, `Restante − ${eur(m.pendiente)} en ${m.nPendientes} proyecto${m.nPendientes === 1 ? "" : "s"} sin emitir`)}
      <div class="card kpi"><div class="label">Proyectos que aún caben</div>${caben}</div>
    </div>
    <p class="muted" style="font-size:12px; margin:10px 0 0;">Importes sin IVA. Orientativo: contrasta el cálculo con tu asesoría.</p>
  </div>`;
}

// Guarda el estado de cobro de un proyecto sin factura real y, al pasar de
// pendiente a emitida/pagada, anota la fecha de emisión (si aún no tenía). Si
// la migración 006 no se ha ejecutado, reintenta sin la fecha para no romper
// el marcado de casillas.
export async function guardarEstadoFacturacion(proyecto, nuevoEstado) {
  const cambios = { estado_facturacion: nuevoEstado };
  if (nuevoEstado === "pendiente") cambios.fecha_emision = null;
  else if (!proyecto.fecha_emision) cambios.fecha_emision = new Date().toISOString().slice(0, 10);

  let res = await db.from("proyectos").update(cambios).eq("id", proyecto.id).exec();
  if (res.error && "fecha_emision" in cambios) {
    delete cambios.fecha_emision;
    res = await db.from("proyectos").update(cambios).eq("id", proyecto.id).exec();
  }
  if (!res.error) Object.assign(proyecto, cambios);
  return res;
}
