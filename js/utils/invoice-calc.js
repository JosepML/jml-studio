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
