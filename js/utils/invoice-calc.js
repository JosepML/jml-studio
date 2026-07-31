// Cálculos de factura y de Modelo 130. Puros (sin dependencias) para poder
// testearlos con node directamente.

export function calcularLineas(lineas) {
  return (lineas || []).reduce((sum, l) => sum + (Number(l.cantidad || 1) * Number(l.precio || 0)), 0);
}

// Descompone una línea en bruto / descuento / neto. El descuento de línea
// puede ser un porcentaje o un importe fijo, y nunca puede dejar la línea en
// negativo (se topa en el propio bruto).
export function desglosarLinea(l) {
  const bruto = round2(Number(l.cantidad || 1) * Number(l.precio || 0));
  const tipo = l.descuento_tipo || "porcentaje";
  const valor = Number(l.descuento_valor || 0);
  const crudo = tipo === "porcentaje" ? bruto * valor / 100 : valor;
  const descuento = round2(Math.min(Math.max(crudo, 0), Math.max(bruto, 0)));
  return { bruto, descuento, neto: round2(bruto - descuento) };
}

// Aplica un descuento global (porcentaje o importe) sobre una base, topado
// para que nunca deje la base por debajo de cero.
export function aplicarDescuentoGlobal(base, tipo = "porcentaje", valor = 0) {
  const crudo = tipo === "porcentaje" ? base * Number(valor || 0) / 100 : Number(valor || 0);
  return round2(Math.min(Math.max(crudo, 0), Math.max(base, 0)));
}

export function calcularFactura({ lineas, ivaPct = 21, retencionPct = 0, descuentoTipo = "porcentaje", descuentoValor = 0 }) {
  const desgloses = (lineas || []).map(desglosarLinea);
  // Subtotal = suma de líneas YA con su descuento de línea aplicado.
  const subtotal = round2(desgloses.reduce((s, d) => s + d.neto, 0));
  const descuentoLineas = round2(desgloses.reduce((s, d) => s + d.descuento, 0));
  const descuentoGlobalImporte = aplicarDescuentoGlobal(subtotal, descuentoTipo, descuentoValor);
  const base = round2(subtotal - descuentoGlobalImporte);
  const iva = round2(base * (ivaPct / 100));
  const retencion = round2(base * (retencionPct / 100));
  const total = round2(base + iva - retencion);
  return {
    base_imponible: base,
    iva_pct: ivaPct, iva_importe: iva,
    retencion_pct: retencionPct, retencion_importe: retencion,
    total,
    // Extras (no se guardan todos en BD, pero los usan el editor y el PDF):
    subtotal, descuento_lineas: descuentoLineas,
    descuento_tipo: descuentoTipo, descuento_valor: Number(descuentoValor || 0),
    descuento_importe: descuentoGlobalImporte,
  };
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Modelo 130: pago fraccionado = 20% del rendimiento neto acumulado del
// trimestre, menos retenciones ya soportadas y menos lo ya ingresado en
// trimestres anteriores del mismo año natural.
export function calcularModelo130({ ingresosBaseTrimestre, gastosTrimestre, retencionesSoportadasTrimestre, pagosPreviosAnio = 0 }) {
  const rendimientoNeto = round2(ingresosBaseTrimestre - gastosTrimestre);
  const pagoBruto = round2(Math.max(rendimientoNeto, 0) * 0.20);
  const aIngresar = round2(Math.max(pagoBruto - retencionesSoportadasTrimestre - pagosPreviosAnio, 0));
  return { rendimientoNeto, pagoBruto, aIngresar };
}

// Pago fraccionado trimestral "plano": % configurable (ver Configuración)
// sobre el rendimiento neto del propio trimestre en curso, SIN acumular con
// trimestres anteriores del año (a diferencia de calcularModelo130 de arriba,
// que hace el cálculo acumulado estándar). Josep usa este método mientras
// esté en su situación/cuota actual — revisable con su gestoría.
export function calcularModelo130Trimestral({ ingresosTrimestre, gastosTrimestre, retencionesTrimestre = 0, pctModelo130 = 7 }) {
  const rendimientoNeto = round2(ingresosTrimestre - gastosTrimestre);
  const pagoBruto = round2(Math.max(rendimientoNeto, 0) * (pctModelo130 / 100));
  const aIngresar = round2(Math.max(pagoBruto - retencionesTrimestre, 0));
  return { rendimientoNeto, pagoBruto, aIngresar };
}

export const PLAZOS_MODELO_130_2026 = [
  { trimestre: 1, inicio: "2026-04-01", fin: "2026-04-20" },
  { trimestre: 2, inicio: "2026-07-01", fin: "2026-07-20" },
  { trimestre: 3, inicio: "2026-10-01", fin: "2026-10-20" },
  { trimestre: 4, inicio: "2027-01-01", fin: "2027-01-20" },
];

// ============ GASTOS: deducibilidad fiscal (IRPF) ============
// El importe del gasto incluye IVA. Si solo una parte del IVA es deducible
// (ej. combustible al 50%), el IVA no recuperado se convierte en un coste real
// y por tanto SÍ es deducible a efectos de IRPF (Modelo 130). Fórmula:
//   deducible = importe_total − iva_soportado × (%IVA_deducible / 100)
// Con un gasto "normal" (100% IVA deducible) esto da: deducible = base sin IVA.
// Con un gasto sin desglose de IVA (iva_soportado = 0) esto da: deducible = importe.
export function gastoDeducibleTotal(gasto) {
  const importe = Number(gasto.importe || 0);
  const ivaSoportado = Number(gasto.iva_soportado || 0);
  const pctDeducible = Number(gasto.iva_deducible_pct ?? 100);
  return round2(importe - ivaSoportado * (pctDeducible / 100));
}

// Reparte el importe deducible de un gasto dentro de un rango de fechas
// [desde, hasta] (strings "YYYY-MM-DD", ambos inclusive). Si el gasto es
// amortizable, prorratea la cuota mes a mes durante meses_amortizacion,
// empezando en fecha_inicio_amortizacion (o en su defecto, en fecha). Si no es
// amortizable, todo el importe deducible cae de golpe en su fecha.
export function gastoDeducibleEnRango(gasto, desde, hasta) {
  const total = gastoDeducibleTotal(gasto);
  if (!gasto.es_amortizable || !gasto.meses_amortizacion) {
    const f = gasto.fecha;
    return (f >= desde && f <= hasta) ? total : 0;
  }
  const cuota = round2(total / gasto.meses_amortizacion);
  const inicioStr = gasto.fecha_inicio_amortizacion || gasto.fecha;
  const anioInicio = Number(inicioStr.slice(0, 4));
  const mesInicio = Number(inicioStr.slice(5, 7)) - 1; // 0-11
  let acumulado = 0;
  for (let i = 0; i < gasto.meses_amortizacion; i++) {
    // Aritmética de calendario pura (sin objetos Date): antes se construía la
    // fecha con `new Date(anio, mes, 1)` y se convertía con toISOString(), pero
    // eso pasa por UTC y en España (UTC+1/+2) devuelve el último día del MES
    // ANTERIOR — p. ej. el 1 de enero de 2026 se convertía en "2025-12-31".
    // Resultado: cada cuota de amortización se imputaba a un mes antes del que
    // le toca, y las de enero se escapaban al año anterior, descuadrando el
    // total deducible del ejercicio. Es el mismo desfase del que ya avisa el
    // comentario de ultimoDiaMes() en gastos-recurrentes.js.
    const mesAbsoluto = mesInicio + i;
    const anio = anioInicio + Math.floor(mesAbsoluto / 12);
    const mes = ((mesAbsoluto % 12) + 12) % 12;
    const iso = `${anio}-${String(mes + 1).padStart(2, "0")}-01`;
    if (iso >= desde && iso <= hasta) acumulado = round2(acumulado + cuota);
  }
  return acumulado;
}

// Suma la parte deducible de una lista de gastos dentro de un rango de fechas.
export function sumaGastosDeduciblesEnRango(gastos, desde, hasta) {
  return round2((gastos || []).reduce((s, g) => s + gastoDeducibleEnRango(g, desde, hasta), 0));
}

// "Gastos de difícil justificación": deducción a tanto alzado del 5% sobre
// (ingresos − gastos deducibles) en estimación directa simplificada, con un
// tope de 2.000 € acumulados por año natural. No es un gasto con ticket: la
// calcula Hacienda (y la gestoría) sobre el rendimiento del periodo.
//
// Vive aquí, junto al resto del cálculo fiscal, porque la usan DOS pantallas.
// Estaba definida solo dentro de financiero.js, así que el Dashboard calculaba
// el Modelo 130 sin ella y mostraba una cifra más alta que Financiero para el
// mismo trimestre (122,14 € frente a 116,04 €: exactamente el 7% de los 87,24 €
// que esta deducción rebaja). Cualquier pantalla que estime el Modelo 130 debe
// llamar a esta función.
//
// El tope es anual y acumulativo, así que hay que ir pasando en
// `acumuladoAnioPrevio` lo ya consumido por los trimestres anteriores del mismo
// año: no se puede calcular un trimestre aislado.
export const TOPE_DIFICIL_JUSTIFICACION_ANUAL = 2000;

export function gastoDificilJustificacion(ingresos, gastosDeducibles, acumuladoAnioPrevio = 0) {
  const baseAntes = round2(Math.max(ingresos - gastosDeducibles, 0));
  const bruto = round2(baseAntes * 0.05);
  const disponible = round2(Math.max(TOPE_DIFICIL_JUSTIFICACION_ANUAL - acumuladoAnioPrevio, 0));
  return round2(Math.min(bruto, disponible));
}
