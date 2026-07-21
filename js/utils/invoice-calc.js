// Cálculos de factura y de Modelo 130. Puros (sin dependencias) para poder
// testearlos con node directamente.

export function calcularLineas(lineas) {
  return (lineas || []).reduce((sum, l) => sum + (Number(l.cantidad || 1) * Number(l.precio || 0)), 0);
}

export function calcularFactura({ lineas, ivaPct = 21, retencionPct = 0 }) {
  const base = round2(calcularLineas(lineas));
  const iva = round2(base * (ivaPct / 100));
  const retencion = round2(base * (retencionPct / 100));
  const total = round2(base + iva - retencion);
  return { base_imponible: base, iva_pct: ivaPct, iva_importe: iva, retencion_pct: retencionPct, retencion_importe: retencion, total };
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
  const inicio = new Date(inicioStr + "T00:00:00");
  let acumulado = 0;
  for (let i = 0; i < gasto.meses_amortizacion; i++) {
    const mesFecha = new Date(inicio.getFullYear(), inicio.getMonth() + i, 1);
    const iso = mesFecha.toISOString().slice(0, 10);
    if (iso >= desde && iso <= hasta) acumulado = round2(acumulado + cuota);
  }
  return acumulado;
}

// Suma la parte deducible de una lista de gastos dentro de un rango de fechas.
export function sumaGastosDeduciblesEnRango(gastos, desde, hasta) {
  return round2((gastos || []).reduce((s, g) => s + gastoDeducibleEnRango(g, desde, hasta), 0));
}
