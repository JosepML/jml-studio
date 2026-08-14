// Exportación a Excel: facturación, gastos y un fichero financiero con
// fórmulas de verdad.
//
// Por qué ExcelJS y no SheetJS: la versión gratuita de SheetJS escribe los
// datos pero NO los estilos (negritas, colores, anchos), y aquí la maquetación
// importa. ExcelJS sí, y además deja poner fórmulas reales, que es lo que pide
// el fichero de Financiero: que los balances se recalculen solos si él toca un
// número, en vez de ser cifras muertas.
//
// Se carga desde el CDN bajo demanda, igual que jsPDF y Chart.js: quien no
// exporte nunca no se descarga el megabyte de librería.
//
// Regla de oro de este fichero: los números salen SIEMPRE de resumen.js e
// invoice-calc.js, nunca recalculados aquí. Si un total del Excel no cuadra
// con la pantalla, el fallo está allí y se arregla allí (ver CLAUDE.md §2.3).

import { round2, gastoDeducibleTotal, gastoDeducibleEnRango } from "./invoice-calc.js";
import {
  construirLedger, resumenPeriodo, rangoAnio, rangoMes,
  conIvaSegunPago, estadoEfectivo, IVA_PCT_DEFECTO,
} from "./resumen.js";
import { CATEGORIAS_GASTO, FORMAS_PAGO } from "./format.js";

const CDN_EXCELJS = "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js";

const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

/* ------------------------------------------------------------- librería */

let cargando = null;
function cargarExcelJs() {
  if (window.ExcelJS) return Promise.resolve();
  if (cargando) return cargando;
  cargando = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = CDN_EXCELJS;
    el.onload = () => resolve();
    el.onerror = () => { cargando = null; reject(new Error("No se ha podido cargar la librería de Excel. ¿Hay conexión?")); };
    document.head.appendChild(el);
  });
  return cargando;
}

/* -------------------------------------------------------------- estilos */

// Paleta alineada con la de la app. Los tonos de estado son los mismos que se
// eligieron pensando en que Josep es daltónico (ver CLAUDE.md §5.1): aquí
// además cada estado lleva su palabra escrita, así que el color solo decora.
const AZUL = "FF1B3A5C";
const AZUL_SUAVE = "FFE8EEF6";
const GRIS_BANDA = "FFF7F9FC";
const VERDE = "FF06A77D";
const AMBAR = "FFB07800";

const EUROS = '#,##0.00\\ "€"';
const PORCENTAJE = "0%";
const FECHA = "dd/mm/yyyy";

function estiloTitulo(celda, texto) {
  celda.value = texto;
  celda.font = { name: "Calibri", size: 15, bold: true, color: { argb: AZUL } };
  celda.alignment = { vertical: "middle" };
}

function estiloSubtitulo(celda, texto) {
  celda.value = texto;
  celda.font = { name: "Calibri", size: 10, italic: true, color: { argb: "FF6B7A90" } };
}

function estiloCabecera(fila, nCols) {
  fila.height = 22;
  for (let i = 1; i <= nCols; i++) {
    const c = fila.getCell(i);
    c.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL } };
    c.alignment = { vertical: "middle", horizontal: i === 1 ? "left" : "center", wrapText: true };
    c.border = { bottom: { style: "thin", color: { argb: AZUL } } };
  }
}

function bandear(fila, nCols, indice) {
  if (indice % 2 === 0) return;
  for (let i = 1; i <= nCols; i++) {
    fila.getCell(i).fill = { type: "pattern", pattern: "solid", fgColor: { argb: GRIS_BANDA } };
  }
}

function estiloTotales(fila, nCols) {
  for (let i = 1; i <= nCols; i++) {
    const c = fila.getCell(i);
    c.font = { bold: true, color: { argb: AZUL } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL_SUAVE } };
    c.border = { top: { style: "medium", color: { argb: AZUL } } };
  }
}

/**
 * Crea una hoja ya maquetada: título, subtítulo, fila de cabecera congelada y
 * autofiltro. Devuelve la hoja y en qué fila empiezan los datos.
 *
 * `cols` = [{ t: "Título", k: "clave", w: ancho, fmt: formato numérico }]
 */
function crearHoja(wb, nombre, titulo, subtitulo, cols) {
  const ws = wb.addWorksheet(nombre, {
    views: [{ state: "frozen", ySplit: 4 }],
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = cols.map(c => ({ key: c.k, width: c.w, style: c.fmt ? { numFmt: c.fmt } : {} }));

  ws.mergeCells(1, 1, 1, cols.length);
  estiloTitulo(ws.getCell(1, 1), titulo);
  ws.getRow(1).height = 24;
  ws.mergeCells(2, 1, 2, cols.length);
  estiloSubtitulo(ws.getCell(2, 1), subtitulo);
  ws.getRow(3).height = 6;

  const cab = ws.getRow(4);
  cols.forEach((c, i) => { cab.getCell(i + 1).value = c.t; });
  estiloCabecera(cab, cols.length);
  cab.commit();

  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: cols.length } };
  return { ws, primeraFila: 5 };
}

async function descargar(wb, nombre) {
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function nuevoLibro() {
  const wb = new window.ExcelJS.Workbook();
  wb.creator = "JML Studio";
  wb.created = new Date();
  return wb;
}

const hoy = () => new Date().toLocaleDateString("es-ES", { day: "2-digit", month: "long", year: "numeric" });

// Nombre de fichero con la fecha de exportación. Estos documentos son una
// FOTO del día en que se sacan: sin la fecha, dos exportaciones del mismo año
// se pisan en la carpeta de Descargas y no hay forma de saber cuál es cuál.
export function sello(base, anio, ext) {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${base}-${anio} (${dd}-${mm}-${d.getFullYear()}).${ext}`;
}

// Agrupa las filas de facturación por cliente. Lo usan el Excel y el PDF.
export function porCliente(filas) {
  const acc = {};
  filas.forEach(f => {
    const k = f.cliente || "—";
    acc[k] ||= { cliente: k, n: 0, base: 0, total: 0, cobrado: 0, pendiente: 0 };
    acc[k].n += 1;
    acc[k].base = round2(acc[k].base + f.base);
    acc[k].total = round2(acc[k].total + f.total);
    if (f.estado === "Cobrada") acc[k].cobrado = round2(acc[k].cobrado + f.base);
    else acc[k].pendiente = round2(acc[k].pendiente + f.base);
  });
  return Object.values(acc).sort((a, b) => b.base - a.base);
}

/* ------------------------------------------------- datos de facturación */

const COLS_FACTURACION = [
  { t: "Mes", k: "mes", w: 12 },
  { t: "Nº mes", k: "mesNum", w: 8 },
  { t: "Fecha", k: "fecha", w: 12, fmt: FECHA },
  { t: "Proyecto", k: "proyecto", w: 46 },
  { t: "Cliente", k: "cliente", w: 26 },
  { t: "Nº factura", k: "factura", w: 13 },
  { t: "Estado", k: "estado", w: 14 },
  { t: "Forma de pago", k: "formaPago", w: 15 },
  { t: "Base (€)", k: "base", w: 14, fmt: EUROS },
  { t: "IVA (€)", k: "iva", w: 12, fmt: EUROS },
  { t: "Total c/IVA (€)", k: "total", w: 15, fmt: EUROS },
];

const ETIQUETA_ESTADO = { pendiente: "Sin facturar", emitida: "Emitida", pagada: "Cobrada" };

// Una fila plana por cada línea del ledger, con el cliente ya resuelto.
export function filasFacturacion(filas, clientes) {
  const nombreCliente = Object.fromEntries((clientes || []).map(c => [c.id, c.nombre]));
  return filas.map(f => {
    const base = round2(f.importeBase);
    const total = conIvaSegunPago(base, f.formaPago);
    const mesNum = f.fecha ? new Date(f.fecha).getMonth() + 1 : 0;
    return {
      mes: mesNum ? MESES[mesNum - 1] : "Sin fecha",
      mesNum,
      fecha: f.fecha ? new Date(f.fecha + "T00:00:00") : null,
      proyecto: f.proyecto?.nombre || "",
      cliente: nombreCliente[f.proyecto?.cliente_id] || "—",
      factura: f.facturaNumero || "—",
      estado: ETIQUETA_ESTADO[estadoEfectivo(f)] || "Sin facturar",
      formaPago: (FORMAS_PAGO[f.formaPago] || FORMAS_PAGO.transferencia).label,
      base,
      iva: round2(total - base),
      total,
    };
  }).sort((a, b) => (a.mesNum - b.mesNum) || String(a.proyecto).localeCompare(String(b.proyecto)));
}

function volcarFilas(ws, primeraFila, cols, datos, { totales = true } = {}) {
  datos.forEach((d, i) => {
    const fila = ws.getRow(primeraFila + i);
    cols.forEach((c, j) => { fila.getCell(j + 1).value = d[c.k] ?? ""; });
    bandear(fila, cols.length, i);
    fila.commit();
  });

  if (!totales || !datos.length) return primeraFila + datos.length;

  const filaTot = ws.getRow(primeraFila + datos.length);
  filaTot.getCell(1).value = "TOTAL";
  cols.forEach((c, j) => {
    if (c.fmt !== EUROS) return;
    const letra = ws.getColumn(j + 1).letter;
    filaTot.getCell(j + 1).value = {
      formula: `SUM(${letra}${primeraFila}:${letra}${primeraFila + datos.length - 1})`,
      result: round2(datos.reduce((s, d) => s + Number(d[c.k] || 0), 0)),
    };
  });
  estiloTotales(filaTot, cols.length);
  filaTot.commit();
  return primeraFila + datos.length + 1;
}

/* ============================================== 1. FACTURACIÓN MENSUAL */

export async function exportarFacturacionExcel({ anio, proyectos, facturaProyectos, gastos, clientes }) {
  await cargarExcelJs();
  const wb = nuevoLibro();

  const ledger = construirLedger(proyectos, facturaProyectos);
  const { desde, hasta } = rangoAnio(anio);
  const anual = resumenPeriodo(ledger, gastos, desde, hasta);
  const todas = filasFacturacion(anual.filas, clientes);

  /* --- Hoja 1: resumen corto ------------------------------------------ */
  const resumen = wb.addWorksheet("Resumen", { views: [{ state: "frozen", ySplit: 4 }] });
  resumen.columns = [
    { width: 30 }, { width: 16 }, { width: 16 }, { width: 16 },
    { width: 16 }, { width: 16 }, { width: 16 }, { width: 12 },
  ];
  resumen.mergeCells("A1:H1");
  estiloTitulo(resumen.getCell("A1"), `Facturación ${anio}`);
  resumen.getRow(1).height = 26;
  resumen.mergeCells("A2:H2");
  estiloSubtitulo(resumen.getCell("A2"), `JML Studio · exportado el ${hoy()} · los importes son base imponible salvo donde se indique`);

  const kpis = [
    ["Total facturado (base)", anual.totalBase],
    ["Total con IVA", anual.totalConIva],
    ["Por transferencia (declarable)", anual.transferencia],
    ["En efectivo", anual.efectivo],
    ["Ya cobrado", round2(anual.transferenciaPagada + anual.efectivoPagada)],
    ["Pendiente de cobro", anual.noPagado],
    ["Gastos deducibles", anual.gastosDeducibles],
    ["Beneficio real", anual.beneficioReal],
  ];
  let r = 4;
  kpis.forEach(([etiqueta, valor], i) => {
    const fila = resumen.getRow(r + i);
    fila.getCell(1).value = etiqueta;
    fila.getCell(1).font = { bold: true, color: { argb: AZUL } };
    const c = fila.getCell(2);
    c.value = valor;
    c.numFmt = EUROS;
    c.alignment = { horizontal: "left" };
    fila.commit();
  });
  r += kpis.length + 2;

  const colsMes = ["Mes", "Proyectos", "Base (€)", "IVA (€)", "Total c/IVA (€)", "Cobrado (€)", "Pendiente (€)", "% cobrado"];
  const cabMes = resumen.getRow(r);
  colsMes.forEach((t, i) => { cabMes.getCell(i + 1).value = t; });
  estiloCabecera(cabMes, colsMes.length);
  cabMes.commit();
  const filaPrimerMes = r + 1;

  MESES.forEach((nombre, idx) => {
    const rm = rangoMes(anio, idx);
    const res = resumenPeriodo(ledger, gastos, rm.desde, rm.hasta);
    const cobrado = round2(res.transferenciaPagada + res.efectivoPagada);
    const conIvaMes = round2(res.filas.reduce((s, f) => s + conIvaSegunPago(f.importeBase, f.formaPago), 0));
    const fila = resumen.getRow(filaPrimerMes + idx);
    fila.getCell(1).value = nombre;
    fila.getCell(2).value = res.filas.length;
    fila.getCell(3).value = res.totalBase;
    fila.getCell(4).value = round2(conIvaMes - res.totalBase);
    fila.getCell(5).value = conIvaMes;
    fila.getCell(6).value = cobrado;
    fila.getCell(7).value = res.noPagado;
    fila.getCell(8).value = { formula: `IF(C${filaPrimerMes + idx}=0,0,F${filaPrimerMes + idx}/C${filaPrimerMes + idx})`, result: res.totalBase ? cobrado / res.totalBase : 0 };
    [3, 4, 5, 6, 7].forEach(c => { fila.getCell(c).numFmt = EUROS; });
    fila.getCell(8).numFmt = PORCENTAJE;
    fila.getCell(6).font = { color: { argb: VERDE } };
    fila.getCell(7).font = { color: { argb: AMBAR } };
    bandear(fila, colsMes.length, idx);
    fila.commit();
  });

  const ultimoMes = filaPrimerMes + 11;
  const totMes = resumen.getRow(ultimoMes + 1);
  totMes.getCell(1).value = "TOTAL AÑO";
  ["B", "C", "D", "E", "F", "G"].forEach((L, i) => {
    totMes.getCell(i + 2).value = { formula: `SUM(${L}${filaPrimerMes}:${L}${ultimoMes})` };
    if (i > 0) totMes.getCell(i + 2).numFmt = EUROS;
  });
  totMes.getCell(8).value = { formula: `IF(C${ultimoMes + 1}=0,0,F${ultimoMes + 1}/C${ultimoMes + 1})` };
  totMes.getCell(8).numFmt = PORCENTAJE;
  estiloTotales(totMes, colsMes.length);
  totMes.commit();

  /* --- Hoja 2: todos los datos en una sola tabla ----------------------- */
  const completo = crearHoja(
    wb, "Datos completos",
    `Facturación ${anio} — todos los proyectos`,
    "Una fila por proyecto (o por línea de factura si un proyecto se reparte en varias). Esta hoja es autosuficiente: contiene todo el año.",
    COLS_FACTURACION,
  );
  volcarFilas(completo.ws, completo.primeraFila, COLS_FACTURACION, todas);

  /* --- Hoja 3: por cliente -------------------------------------------- */
  const COLS_CLIENTE = [
    { t: "Cliente", k: "cliente", w: 34 },
    { t: "Proyectos", k: "n", w: 11 },
    { t: "Base (€)", k: "base", w: 15, fmt: EUROS },
    { t: "Total c/IVA (€)", k: "total", w: 15, fmt: EUROS },
    { t: "Cobrado (€)", k: "cobrado", w: 15, fmt: EUROS },
    { t: "Pendiente (€)", k: "pendiente", w: 15, fmt: EUROS },
  ];
  const hCli = crearHoja(
    wb, "Por cliente", `Facturación ${anio} por cliente`,
    "Ordenados por facturación. Cobrado y pendiente van sobre base imponible.",
    COLS_CLIENTE,
  );
  volcarFilas(hCli.ws, hCli.primeraFila, COLS_CLIENTE, porCliente(todas));

  /* --- Hojas 4-15: un mes por hoja ------------------------------------ */
  MESES.forEach((nombre, idx) => {
    const delMes = todas.filter(d => d.mesNum === idx + 1);
    const h = crearHoja(
      wb, `${String(idx + 1).padStart(2, "0")} ${nombre}`,
      `${nombre} de ${anio}`,
      delMes.length ? `${delMes.length} proyecto${delMes.length === 1 ? "" : "s"}` : "Sin proyectos este mes.",
      COLS_FACTURACION,
    );
    volcarFilas(h.ws, h.primeraFila, COLS_FACTURACION, delMes);
  });

  await descargar(wb, sello("Facturacion", anio, "xlsx"));
}

/* ====================================================== 2. GASTOS */

const COLS_GASTOS = [
  { t: "Mes", k: "mes", w: 12 },
  { t: "Nº mes", k: "mesNum", w: 8 },
  { t: "Fecha", k: "fecha", w: 12, fmt: FECHA },
  { t: "Concepto", k: "concepto", w: 42 },
  { t: "Categoría", k: "categoria", w: 22 },
  { t: "Tipo", k: "tipo", w: 11 },
  { t: "Deducible", k: "deducible", w: 11 },
  { t: "Con factura", k: "conFactura", w: 12 },
  { t: "Importe (€)", k: "importe", w: 14, fmt: EUROS },
  { t: "IVA soportado (€)", k: "ivaSoportado", w: 15, fmt: EUROS },
  { t: "% IVA deducible", k: "ivaPct", w: 14 },
  { t: "Deducible total (€)", k: "deducibleTotal", w: 16, fmt: EUROS },
  { t: "Amortizable", k: "amortizable", w: 12 },
  { t: "Meses amort.", k: "meses", w: 12 },
  { t: "Inicio amort.", k: "inicioAmort", w: 13, fmt: FECHA },
];

export function filasGastos(gastos) {
  return (gastos || []).map(g => {
    const mesNum = g.fecha ? Number(g.fecha.slice(5, 7)) : 0;
    return {
      mes: mesNum ? MESES[mesNum - 1] : "Sin fecha",
      mesNum,
      fecha: g.fecha ? new Date(g.fecha + "T00:00:00") : null,
      concepto: g.concepto || "",
      categoria: (CATEGORIAS_GASTO[g.categoria] || CATEGORIAS_GASTO.otros).label,
      tipo: g.tipo === "fijo" ? "Fijo" : "Variable",
      deducible: g.deducible === false ? "No" : "Sí",
      conFactura: g.con_factura === false ? "No" : "Sí",
      importe: round2(Number(g.importe || 0)),
      ivaSoportado: round2(Number(g.iva_soportado || 0)),
      ivaPct: Number(g.iva_deducible_pct ?? 100) / 100,
      deducibleTotal: g.deducible === false ? 0 : round2(gastoDeducibleTotal(g)),
      amortizable: g.es_amortizable ? "Sí" : "No",
      meses: g.meses_amortizacion || "",
      inicioAmort: g.fecha_inicio_amortizacion ? new Date(g.fecha_inicio_amortizacion + "T00:00:00") : null,
    };
  }).sort((a, b) => (a.mesNum - b.mesNum) || String(a.concepto).localeCompare(String(b.concepto)));
}

export async function exportarGastosExcel({ anio, gastos }) {
  await cargarExcelJs();
  const wb = nuevoLibro();

  const delAnio = (gastos || []).filter(g => (g.fecha || "").startsWith(String(anio)));
  const todas = filasGastos(delAnio);
  const { desde, hasta } = rangoAnio(anio);
  const deducibleAnio = round2((gastos || []).filter(g => g.deducible !== false)
    .reduce((s, g) => s + gastoDeducibleEnRango(g, desde, hasta), 0));

  /* --- Hoja 1: resumen ------------------------------------------------ */
  const resumen = wb.addWorksheet("Resumen", { views: [{ state: "frozen", ySplit: 4 }] });
  resumen.columns = [{ width: 30 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }];
  resumen.mergeCells("A1:F1");
  estiloTitulo(resumen.getCell("A1"), `Gastos ${anio}`);
  resumen.getRow(1).height = 26;
  resumen.mergeCells("A2:F2");
  estiloSubtitulo(resumen.getCell("A2"), `JML Studio · exportado el ${hoy()} · el deducible del año prorratea ya las amortizaciones`);

  const totalAnio = round2(delAnio.reduce((s, g) => s + Number(g.importe || 0), 0));
  const noDeducible = round2(delAnio.filter(g => g.deducible === false).reduce((s, g) => s + Number(g.importe || 0), 0));
  const ivaSoportado = round2(delAnio.filter(g => g.deducible !== false && g.con_factura !== false)
    .reduce((s, g) => s + round2(Number(g.iva_soportado || 0) * (Number(g.iva_deducible_pct ?? 100) / 100)), 0));

  [
    ["Gastos registrados", totalAnio],
    ["Deducible del ejercicio", deducibleAnio],
    ["No deducible", noDeducible],
    ["IVA soportado deducible", ivaSoportado],
    ["Número de gastos", delAnio.length],
  ].forEach(([etiqueta, valor], i) => {
    const fila = resumen.getRow(4 + i);
    fila.getCell(1).value = etiqueta;
    fila.getCell(1).font = { bold: true, color: { argb: AZUL } };
    fila.getCell(2).value = valor;
    if (typeof valor === "number" && etiqueta !== "Número de gastos") fila.getCell(2).numFmt = EUROS;
    fila.commit();
  });

  let r = 11;
  const cabMes = resumen.getRow(r);
  ["Mes", "Nº gastos", "Total (€)", "Deducible (€)", "No deducible (€)", "IVA soportado (€)"].forEach((t, i) => { cabMes.getCell(i + 1).value = t; });
  estiloCabecera(cabMes, 6);
  cabMes.commit();

  const primerMes = r + 1;
  MESES.forEach((nombre, idx) => {
    const rm = rangoMes(anio, idx);
    const delMes = delAnio.filter(g => (g.fecha || "") >= rm.desde && (g.fecha || "") <= rm.hasta);
    const fila = resumen.getRow(primerMes + idx);
    fila.getCell(1).value = nombre;
    fila.getCell(2).value = delMes.length;
    fila.getCell(3).value = round2(delMes.reduce((s, g) => s + Number(g.importe || 0), 0));
    fila.getCell(4).value = round2((gastos || []).filter(g => g.deducible !== false)
      .reduce((s, g) => s + gastoDeducibleEnRango(g, rm.desde, rm.hasta), 0));
    fila.getCell(5).value = round2(delMes.filter(g => g.deducible === false).reduce((s, g) => s + Number(g.importe || 0), 0));
    fila.getCell(6).value = round2(delMes.filter(g => g.deducible !== false && g.con_factura !== false)
      .reduce((s, g) => s + round2(Number(g.iva_soportado || 0) * (Number(g.iva_deducible_pct ?? 100) / 100)), 0));
    [3, 4, 5, 6].forEach(c => { fila.getCell(c).numFmt = EUROS; });
    bandear(fila, 6, idx);
    fila.commit();
  });
  const ultMes = primerMes + 11;
  const totMes = resumen.getRow(ultMes + 1);
  totMes.getCell(1).value = "TOTAL AÑO";
  ["B", "C", "D", "E", "F"].forEach((L, i) => {
    totMes.getCell(i + 2).value = { formula: `SUM(${L}${primerMes}:${L}${ultMes})` };
    if (i > 0) totMes.getCell(i + 2).numFmt = EUROS;
  });
  estiloTotales(totMes, 6);
  totMes.commit();

  // Por categoría, que es como se mira un gasto cuando se busca dónde recortar.
  let rc = ultMes + 3;
  const cabCat = resumen.getRow(rc);
  ["Categoría", "Nº gastos", "Total (€)", "Deducible (€)", "% del total"].forEach((t, i) => { cabCat.getCell(i + 1).value = t; });
  estiloCabecera(cabCat, 5);
  cabCat.commit();

  const porCategoria = {};
  delAnio.forEach(g => {
    const k = g.categoria || "otros";
    porCategoria[k] ||= { n: 0, total: 0, deducible: 0 };
    porCategoria[k].n += 1;
    porCategoria[k].total = round2(porCategoria[k].total + Number(g.importe || 0));
    porCategoria[k].deducible = round2(porCategoria[k].deducible + (g.deducible === false ? 0 : gastoDeducibleTotal(g)));
  });
  Object.entries(porCategoria)
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([k, v], i) => {
      const fila = resumen.getRow(rc + 1 + i);
      fila.getCell(1).value = (CATEGORIAS_GASTO[k] || CATEGORIAS_GASTO.otros).label;
      fila.getCell(2).value = v.n;
      fila.getCell(3).value = v.total;
      fila.getCell(4).value = v.deducible;
      fila.getCell(5).value = { formula: `IF($C$${ultMes + 1}=0,0,C${rc + 1 + i}/$C$${ultMes + 1})`, result: totalAnio ? v.total / totalAnio : 0 };
      fila.getCell(3).numFmt = EUROS;
      fila.getCell(4).numFmt = EUROS;
      fila.getCell(5).numFmt = PORCENTAJE;
      bandear(fila, 5, i);
      fila.commit();
    });

  /* --- Hoja 2: todos los datos ---------------------------------------- */
  const completo = crearHoja(
    wb, "Datos completos",
    `Gastos ${anio} — todos`,
    "Una fila por gasto, con su IVA y su parte deducible. Hoja autosuficiente: contiene todo el año.",
    COLS_GASTOS,
  );
  volcarFilas(completo.ws, completo.primeraFila, COLS_GASTOS, todas);

  /* --- Hojas 3-14: un mes por hoja ------------------------------------ */
  MESES.forEach((nombre, idx) => {
    const delMes = todas.filter(d => d.mesNum === idx + 1);
    const h = crearHoja(
      wb, `${String(idx + 1).padStart(2, "0")} ${nombre}`,
      `${nombre} de ${anio}`,
      delMes.length ? `${delMes.length} gasto${delMes.length === 1 ? "" : "s"}` : "Sin gastos este mes.",
      COLS_GASTOS,
    );
    volcarFilas(h.ws, h.primeraFila, COLS_GASTOS, delMes);
  });

  await descargar(wb, sello("Gastos", anio, "xlsx"));
}

/* ================================================== 3. FINANCIERO */

// Imputación mensual de los gastos: una fila por mes al que va cada gasto.
// Los amortizables se reparten en sus cuotas, que es como se deducen de
// verdad, y así las SUMIFS del balance dan exactamente lo mismo que la app.
// El IVA soportado NO se prorratea: se deduce entero en el trimestre de su
// factura, así que solo se apunta en la fila del mes del gasto.
export function imputacionGastos(gastos, anio) {
  const filas = [];
  (gastos || []).forEach(g => {
    const deducible = g.deducible !== false;
    const mesGasto = (g.fecha || "").startsWith(String(anio)) ? Number(g.fecha.slice(5, 7)) : 0;
    const ivaDeducible = (deducible && g.con_factura !== false)
      ? round2(Number(g.iva_soportado || 0) * (Number(g.iva_deducible_pct ?? 100) / 100))
      : 0;
    const base = {
      concepto: g.concepto || "",
      categoria: (CATEGORIAS_GASTO[g.categoria] || CATEGORIAS_GASTO.otros).label,
      deducible: deducible ? "Sí" : "No",
    };

    if (deducible && g.es_amortizable && g.meses_amortizacion) {
      for (let m = 1; m <= 12; m++) {
        const rm = rangoMes(anio, m - 1);
        const cuota = round2(gastoDeducibleEnRango(g, rm.desde, rm.hasta));
        if (!cuota && m !== mesGasto) continue;
        filas.push({
          ...base,
          mes: MESES[m - 1], mesNum: m,
          apunte: "Cuota de amortización",
          importe: m === mesGasto ? round2(Number(g.importe || 0)) : 0,
          deducibleMes: cuota,
          ivaMes: m === mesGasto ? ivaDeducible : 0,
        });
      }
      return;
    }

    if (!mesGasto) return;   // gasto de otro año: fuera del fichero
    filas.push({
      ...base,
      mes: MESES[mesGasto - 1], mesNum: mesGasto,
      apunte: "Gasto",
      importe: round2(Number(g.importe || 0)),
      deducibleMes: deducible ? round2(gastoDeducibleTotal(g)) : 0,
      ivaMes: ivaDeducible,
    });
  });
  return filas.sort((a, b) => (a.mesNum - b.mesNum) || String(a.concepto).localeCompare(String(b.concepto)));
}

const COLS_FIN_GASTOS = [
  { t: "Mes", k: "mes", w: 12 },
  { t: "Nº mes", k: "mesNum", w: 8 },
  { t: "Concepto", k: "concepto", w: 42 },
  { t: "Categoría", k: "categoria", w: 22 },
  { t: "Tipo de apunte", k: "apunte", w: 20 },
  { t: "Importe total (€)", k: "importe", w: 15, fmt: EUROS },
  { t: "Deducible este mes (€)", k: "deducibleMes", w: 19, fmt: EUROS },
  { t: "IVA deducible (€)", k: "ivaMes", w: 15, fmt: EUROS },
  { t: "Deducible", k: "deducible", w: 11 },
];

export async function exportarFinancieroExcel({ anio, proyectos, facturaProyectos, gastos, clientes, modelo130Pct = 20 }) {
  await cargarExcelJs();
  const wb = nuevoLibro();

  const ledger = construirLedger(proyectos, facturaProyectos);
  const { desde, hasta } = rangoAnio(anio);
  const anual = resumenPeriodo(ledger, gastos, desde, hasta);
  const facturacion = filasFacturacion(anual.filas, clientes);
  const gastosImputados = imputacionGastos(gastos, anio);

  // Las hojas de datos van PRIMERO para que las fórmulas del balance
  // apunten a algo que ya existe al abrir el fichero.
  const hFact = crearHoja(
    wb, "Facturacion", `Facturación ${anio}`,
    "Datos de origen del balance. No la borres: las fórmulas de la hoja Balance apuntan aquí.",
    COLS_FACTURACION,
  );
  volcarFilas(hFact.ws, hFact.primeraFila, COLS_FACTURACION, facturacion, { totales: false });
  const filaFinFact = hFact.primeraFila + facturacion.length - 1;

  const hGas = crearHoja(
    wb, "Gastos", `Gastos ${anio} — imputación mensual`,
    "Los gastos amortizables aparecen repartidos en sus cuotas mensuales, que es como se deducen. El IVA solo se apunta en el mes de la factura.",
    COLS_FIN_GASTOS,
  );
  volcarFilas(hGas.ws, hGas.primeraFila, COLS_FIN_GASTOS, gastosImputados, { totales: false });
  const filaFinGas = hGas.primeraFila + gastosImputados.length - 1;

  const RF = `Facturacion!`;
  const RG = `Gastos!`;
  const rangoF = (col) => `${RF}$${col}$${hFact.primeraFila}:$${col}$${Math.max(filaFinFact, hFact.primeraFila)}`;
  const rangoG = (col) => `${RG}$${col}$${hGas.primeraFila}:$${col}$${Math.max(filaFinGas, hGas.primeraFila)}`;

  /* --- Hoja Balance, con fórmulas ------------------------------------- */
  const ws = wb.addWorksheet("Balance", { views: [{ state: "frozen", ySplit: 5 }] });
  ws.columns = [
    { width: 14 }, { width: 8 }, { width: 17 }, { width: 15 }, { width: 16 },
    { width: 18 }, { width: 18 }, { width: 17 }, { width: 16 },
  ];
  ws.mergeCells("A1:I1");
  estiloTitulo(ws.getCell("A1"), `Balance ${anio}`);
  ws.getRow(1).height = 26;
  ws.mergeCells("A2:I2");
  estiloSubtitulo(ws.getCell("A2"), `JML Studio · exportado el ${hoy()} · todas las cifras se calculan con fórmulas sobre las hojas Facturacion y Gastos: si corriges un dato allí, esto se actualiza solo`);
  ws.getRow(3).height = 6;

  ws.mergeCells("A4:I4");
  const secc = ws.getCell("A4");
  secc.value = "Resultado mes a mes";
  secc.font = { bold: true, size: 12, color: { argb: AZUL } };

  const cab = ws.getRow(5);
  ["Mes", "Nº", "Transferencia (€)", "Efectivo (€)", "Ingresos (€)", "Gastos deducibles (€)", "Gastos no deducibles (€)", "Beneficio fiscal (€)", "Beneficio real (€)"]
    .forEach((t, i) => { cab.getCell(i + 1).value = t; });
  estiloCabecera(cab, 9);
  cab.commit();

  const F0 = 6;   // primera fila de meses
  MESES.forEach((nombre, idx) => {
    const n = idx + 1;
    const f = F0 + idx;
    const rm = rangoMes(anio, idx);
    const res = resumenPeriodo(ledger, gastos, rm.desde, rm.hasta);
    const noDed = round2((gastos || []).filter(g => g.deducible === false && (g.fecha || "") >= rm.desde && (g.fecha || "") <= rm.hasta)
      .reduce((s, g) => s + Number(g.importe || 0), 0));

    const fila = ws.getRow(f);
    fila.getCell(1).value = nombre;
    fila.getCell(2).value = n;
    // SUMIFS contra las hojas de datos. El "result" es el valor que ya calcula
    // la app: así el fichero enseña la cifra correcta nada más abrirlo, sin
    // esperar a que Excel recalcule.
    fila.getCell(3).value = { formula: `SUMIFS(${rangoF("I")},${rangoF("B")},$B${f},${rangoF("H")},"Transferencia")`, result: res.transferencia };
    fila.getCell(4).value = { formula: `SUMIFS(${rangoF("I")},${rangoF("B")},$B${f},${rangoF("H")},"Efectivo")`, result: res.efectivo };
    fila.getCell(5).value = { formula: `C${f}+D${f}`, result: res.totalBase };
    fila.getCell(6).value = { formula: `SUMIFS(${rangoG("G")},${rangoG("B")},$B${f})`, result: res.gastosDeducibles };
    fila.getCell(7).value = { formula: `SUMIFS(${rangoG("F")},${rangoG("B")},$B${f},${rangoG("I")},"No")`, result: noDed };
    fila.getCell(8).value = { formula: `C${f}-F${f}`, result: res.beneficioFiscal };
    fila.getCell(9).value = { formula: `E${f}-F${f}-G${f}`, result: res.beneficioReal };
    for (let c = 3; c <= 9; c++) fila.getCell(c).numFmt = EUROS;
    fila.getCell(8).font = { bold: true };
    bandear(fila, 9, idx);
    fila.commit();
  });

  const FT = F0 + 12;
  const totales = ws.getRow(FT);
  totales.getCell(1).value = "TOTAL AÑO";
  ["C", "D", "E", "F", "G", "H", "I"].forEach((L, i) => {
    totales.getCell(i + 3).value = { formula: `SUM(${L}${F0}:${L}${F0 + 11})` };
    totales.getCell(i + 3).numFmt = EUROS;
  });
  estiloTotales(totales, 9);
  totales.commit();

  /* --- Bloque trimestral: Modelo 130 y Modelo 303 --------------------- */
  let r = FT + 2;
  ws.mergeCells(r, 1, r, 9);
  const s2 = ws.getCell(r, 1);
  s2.value = "Trimestres — Modelo 130 (IRPF) y Modelo 303 (IVA)";
  s2.font = { bold: true, size: 12, color: { argb: AZUL } };
  r += 1;

  const cabT = ws.getRow(r);
  ["Trimestre", "Meses", "Base transferencia (€)", "Gastos deducibles (€)", "Beneficio (€)", `Modelo 130 (${modelo130Pct}%)`, "IVA repercutido (€)", "IVA soportado (€)", "Resultado 303 (€)"]
    .forEach((t, i) => { cabT.getCell(i + 1).value = t; });
  estiloCabecera(cabT, 9);
  cabT.commit();

  const filaPct = r + 6;   // celda donde vive el % del 130, editable
  [1, 2, 3, 4].forEach((q, i) => {
    const f = r + 1 + i;
    const desdeF = F0 + (q - 1) * 3;
    const hastaF = desdeF + 2;
    const fila = ws.getRow(f);
    fila.getCell(1).value = `${q}T`;
    fila.getCell(2).value = `${MESES[(q - 1) * 3].slice(0, 3)}–${MESES[(q - 1) * 3 + 2].slice(0, 3)}`;
    fila.getCell(3).value = { formula: `SUM(C${desdeF}:C${hastaF})` };
    fila.getCell(4).value = { formula: `SUM(F${desdeF}:F${hastaF})` };
    fila.getCell(5).value = { formula: `C${f}-D${f}` };
    fila.getCell(6).value = { formula: `MAX(0,E${f})*$B$${filaPct}` };
    fila.getCell(7).value = { formula: `C${f}*${IVA_PCT_DEFECTO / 100}` };
    fila.getCell(8).value = { formula: `SUMIFS(${rangoG("H")},${rangoG("B")},">="&${(q - 1) * 3 + 1},${rangoG("B")},"<="&${q * 3})` };
    fila.getCell(9).value = { formula: `G${f}-H${f}` };
    for (let c = 3; c <= 9; c++) fila.getCell(c).numFmt = EUROS;
    fila.getCell(6).font = { bold: true };
    fila.getCell(9).font = { bold: true };
    bandear(fila, 9, i);
    fila.commit();
  });

  const fPct = ws.getRow(filaPct);
  fPct.getCell(1).value = "% del Modelo 130 →";
  fPct.getCell(1).font = { bold: true, color: { argb: AZUL } };
  fPct.getCell(2).value = Number(modelo130Pct) / 100;
  fPct.getCell(2).numFmt = PORCENTAJE;
  fPct.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF3C4" } };
  fPct.getCell(2).border = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };
  ws.mergeCells(filaPct, 3, filaPct, 9);
  const nota = ws.getCell(filaPct, 3);
  nota.value = "Cámbialo aquí y los cuatro trimestres se recalculan. El IVA repercutido solo cuenta la transferencia: el efectivo no pasa por el 303.";
  nota.font = { italic: true, size: 10, color: { argb: "FF6B7A90" } };
  fPct.commit();

  const aviso = ws.getRow(filaPct + 2);
  aviso.getCell(1).value = "Documento orientativo generado por JML Studio. No sustituye a tu gestoría: contrasta con ella antes de presentar nada.";
  aviso.getCell(1).font = { italic: true, size: 9, color: { argb: "FF97A3B6" } };
  ws.mergeCells(filaPct + 2, 1, filaPct + 2, 9);
  aviso.commit();

  // El balance es lo primero que debe verse al abrir el fichero.
  wb.worksheets.forEach(h => { h.state = "visible"; });
  wb.views = [{ activeTab: wb.worksheets.findIndex(h => h.name === "Balance") }];

  await descargar(wb, sello("Financiero", anio, "xlsx"));
}
