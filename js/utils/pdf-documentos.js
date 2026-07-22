// Generación de PDFs de factura y presupuesto con jsPDF, replicando EXACTAMENTE
// el diseño real de Josep Mira Lozano (mismo layout que su script reportlab
// "documentos_pdf.py" de la skill facturas-presupuestos-mira). Este módulo es
// una transcripción directa de ese script: todas las coordenadas se calculan
// igual que en reportlab (origen abajo-izquierda, "y" crece hacia arriba) y solo
// se convierten al sistema de jsPDF (origen arriba-izquierda) dentro de las
// funciones de dibujo de bajo nivel (drawString, rectRL, lineRL, imageRL). Así
// el resto del código es una traducción literal del original en Python.

import { eur } from "./format.js";
import { POPPINS_REGULAR_B64, POPPINS_BOLD_B64 } from "./pdf-fonts.js";

const MARGEN = 50;

// Colores muestreados de las plantillas originales
const AZUL_FACTURA = "#C9DAF8";
const GRIS_FACTURA = "#F3F3F3";
const GRIS_CLARO_FACTURA = "#F6F8F9";
const BORDE_FACTURA = "#D9D9D9";

const NAVY = "#1A365D";
const AZUL_TEXTO = "#2B6CB0";
const GRIS_PRESUPUESTO = "#EDF2F7";
const BORDE_PRESUPUESTO = "#E2E8F0";

const NEGRO = "#1A1A1A";
const GRIS_TEXTO = "#4A5568";
const BLANCO = "#FFFFFF";

// ---- Fuente: Poppins (misma que usan los PDFs reales) ----
export function registrarFuentes(doc) {
  doc.addFileToVFS("Poppins-Regular.ttf", POPPINS_REGULAR_B64);
  doc.addFont("Poppins-Regular.ttf", "Poppins", "normal");
  doc.addFileToVFS("Poppins-Bold.ttf", POPPINS_BOLD_B64);
  doc.addFont("Poppins-Bold.ttf", "Poppins", "bold");
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function setFill(doc, hex) { doc.setFillColor(...hexToRgb(hex)); }
function setText(doc, hex) { doc.setTextColor(...hexToRgb(hex)); }
function setStroke(doc, hex) { doc.setDrawColor(...hexToRgb(hex)); }

// ---- Sistema de coordenadas estilo reportlab (y=0 abajo, crece hacia arriba) ----
function pageH(doc) { return doc.internal.pageSize.getHeight(); }
function drawString(doc, x, y, text) { doc.text(String(text), x, pageH(doc) - y); }
function drawCentredString(doc, cx, y, text) { doc.text(String(text), cx, pageH(doc) - y, { align: "center" }); }
function drawRightString(doc, rx, y, text) { doc.text(String(text), rx, pageH(doc) - y, { align: "right" }); }
function lineRL(doc, x1, y1, x2, y2) { doc.line(x1, pageH(doc) - y1, x2, pageH(doc) - y2); }
function rectRL(doc, x, y, w, h, mode) { doc.rect(x, pageH(doc) - (y + h), w, h, mode); }
function imageRL(doc, dataUrl, x, y, w, h) { doc.addImage(dataUrl, "PNG", x, pageH(doc) - (y + h), w, h); }

function formatCantidad(valor) {
  const n = Number(valor);
  if (Number.isInteger(n)) return String(n);
  let s = n.toFixed(2);
  s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s.replace(".", ",");
}

function wrapText(doc, texto, fuente, estilo, tamano, anchoMax) {
  if (!texto) return [];
  doc.setFont(fuente, estilo);
  doc.setFontSize(tamano);
  return doc.splitTextToSize(String(texto), Math.max(anchoMax, 10));
}

// =========================================================
// FACTURA
// =========================================================
// cliente: { nombre, nif, direccion, direccion2? }
// lineas: [{ concepto, cantidad, precio }]
export function crearFacturaPdf(doc, cfg, numero, fechaStr, cliente, lineas, notas) {
  registrarFuentes(doc);
  const emisor = cfg.emisor;
  const ivaPct = cfg.fiscal.iva_pct;
  const retencionPct = cfg.fiscal.retencion_pct || 0;
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();

  // Cabecera: email izq, teléfono der
  doc.setFont("Poppins", "normal"); doc.setFontSize(10);
  setText(doc, NEGRO);
  drawString(doc, MARGEN, H - 45, (emisor.email || "").toUpperCase());
  drawRightString(doc, W - MARGEN, H - 45, emisor.telefono || "");

  // Título
  doc.setFont("Poppins", "bold"); doc.setFontSize(26);
  drawCentredString(doc, W / 2, H - 95, `FACTURA ${numero}`);
  doc.setFont("Poppins", "normal"); doc.setFontSize(11);
  setText(doc, GRIS_TEXTO);
  drawCentredString(doc, W / 2, H - 118, `FECHA ${fechaStr}`);

  // Emisor / Cliente
  const y = H - 155;
  const colIzq = MARGEN;
  const colDer = W / 2 + 10;
  doc.setFont("Poppins", "bold"); doc.setFontSize(10.5);
  setText(doc, NEGRO);
  drawString(doc, colIzq, y, emisor.nombre.toUpperCase());
  drawString(doc, colDer, y, (cliente.nombre || "").toUpperCase());

  doc.setFont("Poppins", "normal"); doc.setFontSize(10);
  setText(doc, GRIS_TEXTO);
  const lineasEmisor = [emisor.nif, emisor.direccion_linea1, emisor.direccion_linea2];
  const lineasCliente = [cliente.nif, cliente.direccion, cliente.direccion2 || ""];
  let yy = y - 15;
  for (let i = 0; i < 3; i++) {
    const le = lineasEmisor[i], lc = lineasCliente[i];
    if (le) drawString(doc, colIzq, yy, le);
    if (lc) drawString(doc, colDer, yy, lc);
    yy -= 14;
  }

  // ---- Tabla de conceptos ----
  const tablaYTop = yy - 20;
  const tablaIzq = MARGEN;
  const tablaDer = W - MARGEN;
  const anchoTotal = tablaDer - tablaIzq;
  const wConcepto = anchoTotal * 0.46;
  const wPrecio = anchoTotal * 0.18;
  const wUnidades = anchoTotal * 0.16;
  const wSubtotal = anchoTotal * 0.20;

  const xConcepto = tablaIzq;
  const xPrecio = xConcepto + wConcepto;
  const xUnidades = xPrecio + wPrecio;
  const xSubtotal = xUnidades + wUnidades;

  const filaAltoHeader = 22;
  setFill(doc, AZUL_FACTURA);
  rectRL(doc, tablaIzq, tablaYTop - filaAltoHeader, anchoTotal, filaAltoHeader, "F");
  doc.setFont("Poppins", "bold"); doc.setFontSize(9);
  setText(doc, NEGRO);
  drawString(doc, xConcepto + 6, tablaYTop - 15, "CONCEPTO");
  drawCentredString(doc, xPrecio + wPrecio / 2, tablaYTop - 15, "PRECIO");
  drawCentredString(doc, xUnidades + wUnidades / 2, tablaYTop - 15, "UNIDADES");
  drawRightString(doc, xSubtotal + wSubtotal - 6, tablaYTop - 15, "SUBTOTAL");

  let yCursor = tablaYTop - filaAltoHeader;
  let subtotalGeneral = 0;
  doc.setFont("Poppins", "normal"); doc.setFontSize(9.5);
  for (const linea of lineas) {
    const importe = Number(linea.cantidad || 1) * Number(linea.precio || 0);
    subtotalGeneral += importe;
    const textoLineas = wrapText(doc, linea.concepto, "Poppins", "normal", 9.5, wConcepto - 12);
    const altoFila = Math.max(28, 14 * textoLineas.length + 14);

    setStroke(doc, BORDE_FACTURA);
    lineRL(doc, tablaIzq, yCursor, tablaDer, yCursor);

    let ty = yCursor - 14;
    setText(doc, NEGRO);
    doc.setFont("Poppins", "normal"); doc.setFontSize(9.5);
    for (const tl of textoLineas) {
      drawString(doc, xConcepto + 6, ty, tl);
      ty -= 12;
    }

    const yMedio = yCursor - altoFila / 2 + 3;
    drawCentredString(doc, xPrecio + wPrecio / 2, yMedio, eur(linea.precio));
    drawCentredString(doc, xUnidades + wUnidades / 2, yMedio, formatCantidad(linea.cantidad || 1));
    drawRightString(doc, xSubtotal + wSubtotal - 6, yMedio, eur(importe));

    yCursor -= altoFila;
  }

  setStroke(doc, BORDE_FACTURA);
  lineRL(doc, tablaIzq, yCursor, tablaDer, yCursor);
  rectRL(doc, tablaIzq, yCursor, anchoTotal, tablaYTop - yCursor, "S");

  // ---- Totales ----
  const ivaImporte = subtotalGeneral * ivaPct / 100;
  const retencionImporte = subtotalGeneral * retencionPct / 100;
  const total = subtotalGeneral + ivaImporte - retencionImporte;

  const filasTotales = [["BASE IMPONIBLE", subtotalGeneral, false, GRIS_CLARO_FACTURA]];
  filasTotales.push([`IVA (${ivaPct}%)`, ivaImporte, false, BLANCO]);
  if (retencionPct) filasTotales.push([`RETENCIÓN IRPF (-${retencionPct}%)`, -retencionImporte, false, BLANCO]);
  filasTotales.push(["TOTAL", total, true, GRIS_FACTURA]);

  const altoFilaTotal = 22;
  for (const [etiqueta, valor, negrita, colorFondo] of filasTotales) {
    setFill(doc, colorFondo);
    rectRL(doc, tablaIzq, yCursor - altoFilaTotal, anchoTotal, altoFilaTotal, "F");
    setStroke(doc, BORDE_FACTURA);
    rectRL(doc, tablaIzq, yCursor - altoFilaTotal, anchoTotal, altoFilaTotal, "S");
    doc.setFont("Poppins", "bold"); doc.setFontSize(negrita ? 10 : 9.5);
    setText(doc, NEGRO);
    drawRightString(doc, xUnidades + wUnidades - 6, yCursor - altoFilaTotal + 7, etiqueta);
    drawRightString(doc, xSubtotal + wSubtotal - 6, yCursor - altoFilaTotal + 7, eur(valor));
    yCursor -= altoFilaTotal;
  }

  yCursor -= 30;

  if (notas) {
    doc.setFont("Poppins", "bold"); doc.setFontSize(9.5);
    setText(doc, NEGRO);
    drawString(doc, MARGEN, yCursor, "NOTAS");
    yCursor -= 14;
    doc.setFont("Poppins", "normal"); doc.setFontSize(9.5);
    for (const tl of wrapText(doc, notas, "Poppins", "normal", 9.5, anchoTotal)) {
      drawString(doc, MARGEN, yCursor, tl);
      yCursor -= 13;
    }
    yCursor -= 15;
  }

  // ---- Medio de pago ----
  if (emisor.iban) {
    const bannerH = 20;
    setFill(doc, AZUL_FACTURA);
    rectRL(doc, tablaIzq, yCursor - bannerH, anchoTotal, bannerH, "F");
    doc.setFont("Poppins", "bold"); doc.setFontSize(9.5);
    setText(doc, NEGRO);
    drawString(doc, xConcepto + 6, yCursor - bannerH + 6, "MEDIO DE PAGO");
    yCursor -= bannerH;

    const datosPago = [
      ["FORMA DE PAGO", "TRANSFERENCIA BANCARIA"],
      ["NOMBRE", emisor.nombre.toUpperCase()],
      ["IBAN", emisor.iban],
      ["BIC/SWIFT", emisor.bic || ""],
      ["CONCEPTO", `FACTURA ${numero}`],
    ];
    const cajaH = 16 * datosPago.length + 10;
    setFill(doc, GRIS_FACTURA);
    rectRL(doc, tablaIzq, yCursor - cajaH, anchoTotal, cajaH, "F");
    let yy2 = yCursor - 14;
    for (const [etiqueta, valor] of datosPago) {
      doc.setFont("Poppins", "bold"); doc.setFontSize(9);
      setText(doc, NEGRO);
      drawString(doc, xConcepto + 6, yy2, etiqueta);
      const anchoEtq = doc.getTextWidth(etiqueta);
      doc.setFont("Poppins", "normal"); doc.setFontSize(9);
      drawString(doc, xConcepto + 6 + anchoEtq + 6, yy2, `- ${valor}`);
      yy2 -= 16;
    }
    yCursor -= cajaH;
  }

  // ---- Firma ----
  doc.setFont("Poppins", "normal"); doc.setFontSize(10);
  setText(doc, NEGRO);
  drawCentredString(doc, W / 2, Math.max(yCursor - 40, 60), emisor.nombre.toUpperCase());

  return { subtotalGeneral, ivaImporte, total };
}

// =========================================================
// PRESUPUESTO
// =========================================================
function nuevaPaginaPresupuesto(doc) {
  doc.addPage();
  return doc.internal.pageSize.getHeight() - MARGEN;
}

// proyecto: string (nombre del proyecto)
// lineas: [{ concepto, descripcion, importe }]
// logoDataUrl: dataURL PNG del logo (opcional)
export function crearPresupuestoPdf(doc, cfg, numero, fechaStr, proyecto, lineas, logoDataUrl) {
  registrarFuentes(doc);
  const emisor = cfg.emisor;
  const ivaPct = cfg.fiscal.iva_pct;
  const condiciones = cfg.presupuesto_condiciones || [];
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();

  // --- Título + logo ---
  doc.setFont("Poppins", "bold"); doc.setFontSize(26);
  setText(doc, NAVY);
  drawString(doc, MARGEN, H - 65, "PRESUPUESTO");

  let logoW = 0, logoH = 0;
  if (logoDataUrl) {
    logoW = 140;
    logoH = logoW * (logoDataUrl.h / logoDataUrl.w);
    imageRL(doc, logoDataUrl.dataUrl, W - MARGEN - logoW, H - 45 - logoH, logoW, logoH);
  }

  doc.setFont("Poppins", "normal"); doc.setFontSize(10.5);
  setText(doc, NEGRO);
  drawString(doc, MARGEN, H - 90, `Nº: ${numero}`);

  // --- Caja Proyecto/Fecha/Emisor/Validez ---
  const tablaIzq = MARGEN;
  const tablaDer = W - MARGEN;
  const anchoTotal = tablaDer - tablaIzq;
  const wL1 = 75;
  const wL2 = 60;
  const wV1 = anchoTotal * 0.36;
  const wV2 = anchoTotal - wL1 - wV1 - wL2;

  const xL1 = tablaIzq;
  const xV1 = xL1 + wL1;
  const xL2 = xV1 + wV1;
  const xV2 = xL2 + wL2;

  const fila1H = 34;
  const fila2H = 44;
  const yTop = H - 145;

  setStroke(doc, "#000000");
  doc.setLineWidth(0.8);
  rectRL(doc, tablaIzq, yTop - fila1H - fila2H, anchoTotal, fila1H + fila2H, "S");
  lineRL(doc, tablaIzq, yTop - fila1H, tablaDer, yTop - fila1H);
  for (const x of [xV1, xL2, xV2]) {
    lineRL(doc, x, yTop, x, yTop - fila1H - fila2H);
  }

  doc.setFont("Poppins", "bold"); doc.setFontSize(9);
  setText(doc, NEGRO);
  drawString(doc, xL1 + 5, yTop - 14, "Proyecto:");
  drawString(doc, xL2 + 5, yTop - 14, "Fecha:");
  drawString(doc, xL1 + 5, yTop - fila1H - 16, "Emisor:");
  drawString(doc, xL2 + 5, yTop - fila1H - 16, "Validez:");

  doc.setFont("Poppins", "normal"); doc.setFontSize(9);
  const proyectoLineas = wrapText(doc, proyecto, "Poppins", "normal", 9, wV1 - 10).slice(0, 2);
  proyectoLineas.forEach((tl, idx) => drawString(doc, xV1 + 5, yTop - 14 - 12 * idx, tl));
  drawString(doc, xV2 + 5, yTop - 14, fechaStr);

  drawString(doc, xV1 + 5, yTop - fila1H - 16, emisor.nombre);
  doc.setFont("Poppins", "normal"); doc.setFontSize(8.3);
  drawString(doc, xV1 + 5, yTop - fila1H - 29, emisor.actividad || "");
  doc.setFont("Poppins", "normal"); doc.setFontSize(9);
  drawString(doc, xV2 + 5, yTop - fila1H - 16, "30 días");

  let yCursor = yTop - fila1H - fila2H - 30;

  // --- Desglose de servicio ---
  doc.setFont("Poppins", "bold"); doc.setFontSize(12.5);
  setText(doc, AZUL_TEXTO);
  drawString(doc, MARGEN, yCursor, "Desglose de Servicio");
  yCursor -= 22;

  const wConcepto = anchoTotal * 0.75;
  const wImporte = anchoTotal - wConcepto;
  const xConcepto = tablaIzq;
  const xImporte = xConcepto + wConcepto;

  const filaHHeader = 26;
  if (yCursor - filaHHeader < 120) yCursor = nuevaPaginaPresupuesto(doc);

  const dibujarCabeceraTabla = () => {
    setFill(doc, NAVY);
    rectRL(doc, tablaIzq, yCursor - filaHHeader, anchoTotal, filaHHeader, "F");
    doc.setFont("Poppins", "bold"); doc.setFontSize(9.5);
    setText(doc, BLANCO);
    drawString(doc, xConcepto + 8, yCursor - filaHHeader + 9, "CONCEPTO / DESCRIPCIÓN");
    drawRightString(doc, xImporte + wImporte - 8, yCursor - filaHHeader + 9, "IMPORTE");
    yCursor -= filaHHeader;
  };
  dibujarCabeceraTabla();

  let subtotalGeneral = 0;
  for (const linea of lineas) {
    const importe = Number(linea.importe || 0);
    subtotalGeneral += importe;

    const descLineas = wrapText(doc, linea.descripcion || "", "Poppins", "normal", 9, wConcepto - 16);
    const altoFila = 18 + 12 * Math.max(1, descLineas.length) + 8;

    if (yCursor - altoFila < 140) {
      yCursor = nuevaPaginaPresupuesto(doc);
      dibujarCabeceraTabla();
    }

    setStroke(doc, BORDE_PRESUPUESTO);
    doc.setFont("Poppins", "bold"); doc.setFontSize(9.5);
    setText(doc, NEGRO);
    let ty = yCursor - 15;
    drawString(doc, xConcepto + 8, ty, linea.concepto || "");
    doc.setFont("Poppins", "normal"); doc.setFontSize(8.8);
    setText(doc, GRIS_TEXTO);
    ty -= 13;
    for (const dl of descLineas) {
      drawString(doc, xConcepto + 8, ty, dl);
      ty -= 12;
    }

    doc.setFont("Poppins", "bold"); doc.setFontSize(9.5);
    setText(doc, NEGRO);
    drawRightString(doc, xImporte + wImporte - 8, yCursor - altoFila / 2 + 3, eur(importe));

    yCursor -= altoFila;
    lineRL(doc, tablaIzq, yCursor, tablaDer, yCursor);
  }

  // --- Totales ---
  const ivaImporte = subtotalGeneral * ivaPct / 100;
  const total = subtotalGeneral + ivaImporte;

  const filasTotales = [
    ["Precio (Base Imponible)", subtotalGeneral],
    [`IVA (${ivaPct}%)`, ivaImporte],
    ["TOTAL", total],
  ];
  const altoFilaTotal = 26;
  if (yCursor - altoFilaTotal * 3 < 60) yCursor = nuevaPaginaPresupuesto(doc);

  doc.setLineWidth(1.2);
  setStroke(doc, NAVY);
  lineRL(doc, tablaIzq, yCursor, tablaDer, yCursor);
  for (const [etiqueta, valor] of filasTotales) {
    setFill(doc, GRIS_PRESUPUESTO);
    rectRL(doc, tablaIzq, yCursor - altoFilaTotal, anchoTotal, altoFilaTotal, "F");
    doc.setFont("Poppins", "bold"); doc.setFontSize(10);
    setText(doc, NEGRO);
    drawString(doc, xConcepto + 8, yCursor - altoFilaTotal + 9, etiqueta);
    drawRightString(doc, xImporte + wImporte - 8, yCursor - altoFilaTotal + 9, eur(valor));
    yCursor -= altoFilaTotal;
  }
  setStroke(doc, NAVY);
  lineRL(doc, tablaIzq, yCursor, tablaDer, yCursor);

  // --- Página 2: condiciones y contacto ---
  yCursor = nuevaPaginaPresupuesto(doc);

  doc.setFont("Poppins", "bold"); doc.setFontSize(12);
  setText(doc, NEGRO);
  drawString(doc, MARGEN, yCursor, "Condiciones y Notas Generales:");
  yCursor -= 18;

  const bloqueLineas = condiciones.map(cond => wrapText(doc, cond, "Poppins", "normal", 9.5, anchoTotal - 30));
  const altoBloque = bloqueLineas.reduce((s, w) => s + 12 * w.length + 6, 0) + 12;

  setFill(doc, GRIS_PRESUPUESTO);
  rectRL(doc, tablaIzq, yCursor - altoBloque, anchoTotal, altoBloque, "F");
  let yy = yCursor - 14;
  doc.setFont("Poppins", "normal"); doc.setFontSize(9.5);
  setText(doc, NEGRO);
  for (const wrapped of bloqueLineas) {
    drawString(doc, tablaIzq + 12, yy, "•");
    for (const tl of wrapped) {
      drawString(doc, tablaIzq + 24, yy, tl);
      yy -= 12;
    }
    yy -= 6;
  }
  yCursor -= altoBloque + 25;

  doc.setFont("Poppins", "bold"); doc.setFontSize(12.5);
  setText(doc, AZUL_TEXTO);
  drawString(doc, MARGEN, yCursor, "CONTACTO Y ACEPTACIÓN");
  yCursor -= 20;

  doc.setFont("Poppins", "normal"); doc.setFontSize(9.5);
  setText(doc, NEGRO);
  const intro = "Para cualquier duda o aclaración sobre los conceptos detallados, puedes ponerte en contacto a través de las siguientes vías:";
  for (const tl of wrapText(doc, intro, "Poppins", "normal", 9.5, anchoTotal)) {
    drawString(doc, MARGEN, yCursor, tl);
    yCursor -= 13;
  }
  yCursor -= 6;

  drawString(doc, MARGEN + 12, yCursor, `• Teléfono: ${emisor.telefono || ""}`);
  yCursor -= 15;
  drawString(doc, MARGEN + 12, yCursor, `• Email: ${emisor.email || ""}`);
  yCursor -= 40;

  doc.setFont("Poppins", "normal"); doc.setFontSize(10);
  drawRightString(doc, tablaDer, yCursor, emisor.nombre);

  if (logoDataUrl) {
    const logoW2 = 130;
    const logoH2 = logoW2 * (logoDataUrl.h / logoDataUrl.w);
    imageRL(doc, logoDataUrl.dataUrl, W / 2 - logoW2 / 2, 70, logoW2, logoH2);
  }

  return { subtotalGeneral, ivaImporte, total };
}

// Carga assets/logo.png (relativo a la raíz de la app) y devuelve
// { dataUrl, w, h } listo para pasar a crearPresupuestoPdf, o null si falla.
export async function cargarLogoDataUrl() {
  try {
    const resp = await fetch("assets/logo.png");
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    const { w, h } = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = reject;
      img.src = dataUrl;
    });
    return { dataUrl, w, h };
  } catch {
    return null;
  }
}
