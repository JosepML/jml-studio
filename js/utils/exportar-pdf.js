// Los mismos tres informes que exportar-excel.js, pero en PDF: para imprimir,
// mandar por correo o guardar como copia estática de un momento concreto.
//
// Comparte las funciones que arman las filas con exportar-excel.js a propósito.
// Si cada exportación construyera sus datos por su cuenta, acabarían diciendo
// cosas distintas —es exactamente el problema que resolvió resumen.js— y el
// PDF y el Excel del mismo mes no cuadrarían.
//
// jsPDF + autoTable, los dos desde el CDN y solo cuando se usan. jsPDF ya se
// usa para las facturas; autoTable es lo que dibuja tablas con cabecera
// repetida en cada página y saltos automáticos.

import { round2, gastoDeducibleEnRango } from "./invoice-calc.js";
import {
  construirLedger, resumenPeriodo, rangoAnio, rangoMes,
  conIvaSegunPago, IVA_PCT_DEFECTO,
} from "./resumen.js";
import { CATEGORIAS_GASTO, eur } from "./format.js";
import { filasFacturacion, filasGastos, imputacionGastos } from "./exportar-excel.js";

const CDN_JSPDF = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
const CDN_AUTOTABLE = "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js";

const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

// Los mismos colores que el Excel y que la app.
const AZUL = [27, 58, 92];
const GRIS = [107, 122, 144];
const BANDA = [247, 249, 252];

function guion(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error("No se ha podido cargar el generador de PDF. ¿Hay conexión?"));
    document.head.appendChild(el);
  });
}

async function cargarPdf() {
  if (!window.jspdf) await guion(CDN_JSPDF);
  // autoTable se engancha al prototipo de jsPDF, así que el orden importa.
  if (!window.jspdf?.jsPDF?.API?.autoTable) await guion(CDN_AUTOTABLE);
  return window.jspdf.jsPDF;
}

const hoy = () => new Date().toLocaleDateString("es-ES", { day: "2-digit", month: "long", year: "numeric" });

/* -------------------------------------------------------------- piezas */

function portada(pdf, titulo, subtitulo) {
  const ancho = pdf.internal.pageSize.getWidth();
  pdf.setFillColor(...AZUL);
  pdf.rect(0, 0, ancho, 54, "F");
  pdf.setTextColor(255, 255, 255);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(18);
  pdf.text(titulo, 40, 28);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  pdf.text(subtitulo, 40, 43);
  pdf.setTextColor(0, 0, 0);
  return 78;
}

function seccion(pdf, texto, y) {
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(12);
  pdf.setTextColor(...AZUL);
  pdf.text(texto, 40, y);
  pdf.setTextColor(0, 0, 0);
  return y + 8;
}

function tabla(pdf, y, cabecera, cuerpo, opciones = {}) {
  pdf.autoTable({
    startY: y,
    head: [cabecera],
    body: cuerpo,
    theme: "grid",
    margin: { left: 40, right: 40 },
    styles: { font: "helvetica", fontSize: 8, cellPadding: 4, lineColor: [225, 231, 240], lineWidth: 0.5 },
    headStyles: { fillColor: AZUL, textColor: 255, fontStyle: "bold", fontSize: 8 },
    alternateRowStyles: { fillColor: BANDA },
    ...opciones,
  });
  return pdf.lastAutoTable.finalY + 22;
}

// Columnas de dinero a la derecha. autoTable las quiere por índice.
function derecha(indices, ancho) {
  const estilos = {};
  indices.forEach(i => { estilos[i] = { halign: "right", cellWidth: ancho || "auto" }; });
  return estilos;
}

function pieDePagina(pdf) {
  const total = pdf.internal.getNumberOfPages();
  const ancho = pdf.internal.pageSize.getWidth();
  const alto = pdf.internal.pageSize.getHeight();
  for (let i = 1; i <= total; i++) {
    pdf.setPage(i);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7.5);
    pdf.setTextColor(...GRIS);
    pdf.text("JML Studio", 40, alto - 22);
    pdf.text(`Página ${i} de ${total}`, ancho - 40, alto - 22, { align: "right" });
  }
  pdf.setTextColor(0, 0, 0);
}

// Un salto de página si lo que viene no cabe: evita el título de un mes
// huérfano al final de la hoja, con su tabla ya en la siguiente.
function sitio(pdf, y, necesario = 120) {
  if (y + necesario < pdf.internal.pageSize.getHeight() - 50) return y;
  pdf.addPage();
  return 60;
}

function nuevoPdf(jsPDF) {
  return new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
}

/* ================================================ 1. FACTURACIÓN */

export async function exportarFacturacionPdf({ anio, proyectos, facturaProyectos, gastos, clientes }) {
  const jsPDF = await cargarPdf();
  const pdf = nuevoPdf(jsPDF);

  const ledger = construirLedger(proyectos, facturaProyectos);
  const { desde, hasta } = rangoAnio(anio);
  const anual = resumenPeriodo(ledger, gastos, desde, hasta);
  const todas = filasFacturacion(anual.filas, clientes);

  let y = portada(pdf, `Facturación ${anio}`, `Exportado el ${hoy()} · importes en base imponible salvo donde se indique`);

  y = seccion(pdf, "Resumen del año", y);
  y = tabla(pdf, y,
    ["Total facturado", "Con IVA", "Transferencia", "Efectivo", "Cobrado", "Pendiente", "Gastos deducibles", "Beneficio real"],
    [[
      eur(anual.totalBase), eur(anual.totalConIva), eur(anual.transferencia), eur(anual.efectivo),
      eur(round2(anual.transferenciaPagada + anual.efectivoPagada)), eur(anual.noPagado),
      eur(anual.gastosDeducibles), eur(anual.beneficioReal),
    ]],
    { columnStyles: derecha([0, 1, 2, 3, 4, 5, 6, 7]), styles: { font: "helvetica", fontSize: 9, cellPadding: 6, halign: "right" } },
  );

  y = seccion(pdf, "Mes a mes", y);
  const filasMes = MESES.map((nombre, idx) => {
    const rm = rangoMes(anio, idx);
    const res = resumenPeriodo(ledger, gastos, rm.desde, rm.hasta);
    const cobrado = round2(res.transferenciaPagada + res.efectivoPagada);
    const conIvaMes = round2(res.filas.reduce((s, f) => s + conIvaSegunPago(f.importeBase, f.formaPago), 0));
    return [
      nombre, String(res.filas.length), eur(res.totalBase), eur(round2(conIvaMes - res.totalBase)),
      eur(conIvaMes), eur(cobrado), eur(res.noPagado),
      res.totalBase ? `${Math.round(cobrado / res.totalBase * 100)} %` : "—",
    ];
  });
  filasMes.push([
    "TOTAL", String(todas.length), eur(anual.totalBase),
    eur(round2(anual.totalConIva - anual.totalBase)), eur(anual.totalConIva),
    eur(round2(anual.transferenciaPagada + anual.efectivoPagada)), eur(anual.noPagado),
    anual.totalBase ? `${Math.round((anual.transferenciaPagada + anual.efectivoPagada) / anual.totalBase * 100)} %` : "—",
  ]);
  y = tabla(pdf, y,
    ["Mes", "Proyectos", "Base", "IVA", "Total c/IVA", "Cobrado", "Pendiente", "% cobrado"],
    filasMes,
    {
      columnStyles: derecha([1, 2, 3, 4, 5, 6, 7]),
      didParseCell: (d) => { if (d.row.index === filasMes.length - 1) d.cell.styles.fontStyle = "bold"; },
    },
  );

  // Un bloque por mes, saltando los vacíos: doce hojas medio en blanco no
  // ayudan a nadie y engordan el fichero.
  MESES.forEach((nombre, idx) => {
    const delMes = todas.filter(d => d.mesNum === idx + 1);
    if (!delMes.length) return;
    y = sitio(pdf, y, 140);
    y = seccion(pdf, `${nombre} — ${delMes.length} proyecto${delMes.length === 1 ? "" : "s"}`, y);
    const cuerpo = delMes.map(d => [
      d.proyecto, d.cliente, d.factura, d.estado, d.formaPago,
      eur(d.base), eur(d.iva), eur(d.total),
    ]);
    cuerpo.push([
      "TOTAL", "", "", "", "",
      eur(round2(delMes.reduce((s, d) => s + d.base, 0))),
      eur(round2(delMes.reduce((s, d) => s + d.iva, 0))),
      eur(round2(delMes.reduce((s, d) => s + d.total, 0))),
    ]);
    y = tabla(pdf, y,
      ["Proyecto", "Cliente", "Nº factura", "Estado", "Forma de pago", "Base", "IVA", "Total c/IVA"],
      cuerpo,
      {
        columnStyles: { 0: { cellWidth: 220 }, ...derecha([5, 6, 7]) },
        didParseCell: (d) => { if (d.row.index === cuerpo.length - 1) d.cell.styles.fontStyle = "bold"; },
      },
    );
  });

  pieDePagina(pdf);
  pdf.save(`Facturacion-${anio}.pdf`);
}

/* ===================================================== 2. GASTOS */

export async function exportarGastosPdf({ anio, gastos }) {
  const jsPDF = await cargarPdf();
  const pdf = nuevoPdf(jsPDF);

  const delAnio = (gastos || []).filter(g => (g.fecha || "").startsWith(String(anio)));
  const todas = filasGastos(delAnio);
  const { desde, hasta } = rangoAnio(anio);
  const deducibleAnio = round2((gastos || []).filter(g => g.deducible !== false)
    .reduce((s, g) => s + gastoDeducibleEnRango(g, desde, hasta), 0));
  const totalAnio = round2(delAnio.reduce((s, g) => s + Number(g.importe || 0), 0));
  const noDeducible = round2(delAnio.filter(g => g.deducible === false).reduce((s, g) => s + Number(g.importe || 0), 0));
  const ivaDeducible = (lista) => round2(lista.filter(g => g.deducible !== false && g.con_factura !== false)
    .reduce((s, g) => s + round2(Number(g.iva_soportado || 0) * (Number(g.iva_deducible_pct ?? 100) / 100)), 0));

  let y = portada(pdf, `Gastos ${anio}`, `Exportado el ${hoy()} · el deducible del ejercicio ya lleva prorrateadas las amortizaciones`);

  y = seccion(pdf, "Resumen del año", y);
  y = tabla(pdf, y,
    ["Gastos registrados", "Deducible del ejercicio", "No deducible", "IVA soportado deducible", "Nº de gastos"],
    [[eur(totalAnio), eur(deducibleAnio), eur(noDeducible), eur(ivaDeducible(delAnio)), String(delAnio.length)]],
    { columnStyles: derecha([0, 1, 2, 3, 4]), styles: { font: "helvetica", fontSize: 9, cellPadding: 6, halign: "right" } },
  );

  y = seccion(pdf, "Mes a mes", y);
  const filasMes = MESES.map((nombre, idx) => {
    const rm = rangoMes(anio, idx);
    const delMes = delAnio.filter(g => (g.fecha || "") >= rm.desde && (g.fecha || "") <= rm.hasta);
    const ded = round2((gastos || []).filter(g => g.deducible !== false)
      .reduce((s, g) => s + gastoDeducibleEnRango(g, rm.desde, rm.hasta), 0));
    return [
      nombre, String(delMes.length),
      eur(round2(delMes.reduce((s, g) => s + Number(g.importe || 0), 0))),
      eur(ded),
      eur(round2(delMes.filter(g => g.deducible === false).reduce((s, g) => s + Number(g.importe || 0), 0))),
      eur(ivaDeducible(delMes)),
    ];
  });
  filasMes.push(["TOTAL", String(delAnio.length), eur(totalAnio), eur(deducibleAnio), eur(noDeducible), eur(ivaDeducible(delAnio))]);
  y = tabla(pdf, y, ["Mes", "Nº gastos", "Total", "Deducible", "No deducible", "IVA soportado"], filasMes, {
    columnStyles: derecha([1, 2, 3, 4, 5]),
    didParseCell: (d) => { if (d.row.index === filasMes.length - 1) d.cell.styles.fontStyle = "bold"; },
  });

  y = sitio(pdf, y, 160);
  y = seccion(pdf, "Por categoría", y);
  const porCategoria = {};
  delAnio.forEach(g => {
    const k = g.categoria || "otros";
    porCategoria[k] ||= { n: 0, total: 0 };
    porCategoria[k].n += 1;
    porCategoria[k].total = round2(porCategoria[k].total + Number(g.importe || 0));
  });
  y = tabla(pdf, y, ["Categoría", "Nº gastos", "Total", "% del total"],
    Object.entries(porCategoria).sort((a, b) => b[1].total - a[1].total).map(([k, v]) => [
      (CATEGORIAS_GASTO[k] || CATEGORIAS_GASTO.otros).label, String(v.n), eur(v.total),
      totalAnio ? `${Math.round(v.total / totalAnio * 100)} %` : "—",
    ]),
    { columnStyles: derecha([1, 2, 3]) },
  );

  MESES.forEach((nombre, idx) => {
    const delMes = todas.filter(d => d.mesNum === idx + 1);
    if (!delMes.length) return;
    y = sitio(pdf, y, 140);
    y = seccion(pdf, `${nombre} — ${delMes.length} gasto${delMes.length === 1 ? "" : "s"}`, y);
    const cuerpo = delMes.map(d => [
      d.concepto, d.categoria, d.tipo, d.deducible, d.conFactura,
      eur(d.importe), eur(d.ivaSoportado), eur(d.deducibleTotal),
    ]);
    cuerpo.push([
      "TOTAL", "", "", "", "",
      eur(round2(delMes.reduce((s, d) => s + d.importe, 0))),
      eur(round2(delMes.reduce((s, d) => s + d.ivaSoportado, 0))),
      eur(round2(delMes.reduce((s, d) => s + d.deducibleTotal, 0))),
    ]);
    y = tabla(pdf, y,
      ["Concepto", "Categoría", "Tipo", "Deducible", "Con factura", "Importe", "IVA soportado", "Deducible total"],
      cuerpo,
      {
        columnStyles: { 0: { cellWidth: 200 }, ...derecha([5, 6, 7]) },
        didParseCell: (d) => { if (d.row.index === cuerpo.length - 1) d.cell.styles.fontStyle = "bold"; },
      },
    );
  });

  pieDePagina(pdf);
  pdf.save(`Gastos-${anio}.pdf`);
}

/* ================================================= 3. FINANCIERO */

export async function exportarFinancieroPdf({ anio, proyectos, facturaProyectos, gastos, clientes, modelo130Pct = 20 }) {
  const jsPDF = await cargarPdf();
  const pdf = nuevoPdf(jsPDF);

  const ledger = construirLedger(proyectos, facturaProyectos);
  const { desde, hasta } = rangoAnio(anio);
  const anual = resumenPeriodo(ledger, gastos, desde, hasta);
  const imputados = imputacionGastos(gastos, anio);

  let y = portada(pdf, `Balance ${anio}`, `Exportado el ${hoy()} · documento orientativo, contrástalo con tu gestoría antes de presentar nada`);

  y = seccion(pdf, "El año de un vistazo", y);
  y = tabla(pdf, y,
    ["Ingresos totales", "Transferencia", "Efectivo", "Gastos deducibles", "No deducibles", "Beneficio fiscal", "Beneficio real"],
    [[
      eur(anual.totalBase), eur(anual.transferencia), eur(anual.efectivo),
      eur(anual.gastosDeducibles), eur(anual.gastosNoDeducibles),
      eur(anual.beneficioFiscal), eur(anual.beneficioReal),
    ]],
    { columnStyles: derecha([0, 1, 2, 3, 4, 5, 6]), styles: { font: "helvetica", fontSize: 9, cellPadding: 6, halign: "right" } },
  );

  y = seccion(pdf, "Resultado mes a mes", y);
  const porMes = MESES.map((nombre, idx) => {
    const rm = rangoMes(anio, idx);
    const res = resumenPeriodo(ledger, gastos, rm.desde, rm.hasta);
    const noDed = round2((gastos || []).filter(g => g.deducible === false && (g.fecha || "") >= rm.desde && (g.fecha || "") <= rm.hasta)
      .reduce((s, g) => s + Number(g.importe || 0), 0));
    return { nombre, res, noDed };
  });
  const filasBalance = porMes.map(({ nombre, res, noDed }) => [
    nombre, eur(res.transferencia), eur(res.efectivo), eur(res.totalBase),
    eur(res.gastosDeducibles), eur(noDed), eur(res.beneficioFiscal), eur(res.beneficioReal),
  ]);
  filasBalance.push([
    "TOTAL", eur(anual.transferencia), eur(anual.efectivo), eur(anual.totalBase),
    eur(anual.gastosDeducibles), eur(anual.gastosNoDeducibles),
    eur(anual.beneficioFiscal), eur(anual.beneficioReal),
  ]);
  y = tabla(pdf, y,
    ["Mes", "Transferencia", "Efectivo", "Ingresos", "Gastos deducibles", "No deducibles", "Beneficio fiscal", "Beneficio real"],
    filasBalance,
    {
      columnStyles: derecha([1, 2, 3, 4, 5, 6, 7]),
      didParseCell: (d) => { if (d.row.index === filasBalance.length - 1) d.cell.styles.fontStyle = "bold"; },
    },
  );

  y = sitio(pdf, y, 170);
  y = seccion(pdf, `Trimestres — Modelo 130 (${modelo130Pct} %) y Modelo 303`, y);
  const filasQ = [1, 2, 3, 4].map(q => {
    const meses = porMes.slice((q - 1) * 3, q * 3);
    const baseQ = round2(meses.reduce((s, m) => s + m.res.transferencia, 0));
    const dedQ = round2(meses.reduce((s, m) => s + m.res.gastosDeducibles, 0));
    const beneficio = round2(baseQ - dedQ);
    const ivaRep = round2(baseQ * IVA_PCT_DEFECTO / 100);
    const ivaSop = round2(imputados
      .filter(f => f.mesNum >= (q - 1) * 3 + 1 && f.mesNum <= q * 3)
      .reduce((s, f) => s + Number(f.ivaMes || 0), 0));
    return [
      `${q}T`, `${MESES[(q - 1) * 3].slice(0, 3)}–${MESES[(q - 1) * 3 + 2].slice(0, 3)}`,
      eur(baseQ), eur(dedQ), eur(beneficio),
      eur(round2(Math.max(0, beneficio) * modelo130Pct / 100)),
      eur(ivaRep), eur(ivaSop), eur(round2(ivaRep - ivaSop)),
    ];
  });
  y = tabla(pdf, y,
    ["Trimestre", "Meses", "Base transferencia", "Gastos deducibles", "Beneficio", `Modelo 130`, "IVA repercutido", "IVA soportado", "Resultado 303"],
    filasQ,
    { columnStyles: derecha([2, 3, 4, 5, 6, 7, 8]) },
  );

  pdf.setFont("helvetica", "italic");
  pdf.setFontSize(8);
  pdf.setTextColor(...GRIS);
  // Dos avisos: splitTextToSize en vez de la opción maxWidth (con maxWidth la
  // línea salía entera y se cortaba por el margen), y NADA de caracteres raros
  // aquí dentro. El signo "menos" matemático (U+2212) hacía que jsPDF calculara
  // mal el ancho y dibujara toda la frase con un espaciado enorme que se salía
  // de la página. Con guiones y letras normales no pasa.
  const aviso = pdf.splitTextToSize(
    "El IVA repercutido solo cuenta la facturación por transferencia: el efectivo no pasa por el 303. El Modelo 130 aquí es una estimación sobre (base menos gastos deducibles) del trimestre.",
    pdf.internal.pageSize.getWidth() - 80,
  );
  pdf.text(aviso, 40, Math.min(y, pdf.internal.pageSize.getHeight() - 60));
  pdf.setTextColor(0, 0, 0);

  pieDePagina(pdf);
  pdf.save(`Financiero-${anio}.pdf`);
}
