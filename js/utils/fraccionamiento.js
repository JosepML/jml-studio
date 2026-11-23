import { round2 } from "./invoice-calc.js";

export const TOTAL_FRACCIONES = 2;

export const MAX_FRACCIONES = 6;

export function normalizarPorcentajes(valores) {
  const porcentajes = (valores || []).map(v => round2(Number(String(v).replace(",", "."))));
  if (porcentajes.length < 2 || porcentajes.length > MAX_FRACCIONES) return null;
  if (porcentajes.some(v => !Number.isFinite(v) || v <= 0)) return null;
  const total = round2(porcentajes.reduce((s, v) => s + v, 0));
  return total === 100 ? porcentajes : null;
}

export function porcentajesIguales(numero) {
  const n = Math.max(2, Math.min(MAX_FRACCIONES, Number(numero) || 2));
  const base = round2(100 / n);
  return Array.from({ length: n }, (_, i) => i === n - 1 ? round2(100 - base * (n - 1)) : base);
}

export function dividirImporte(importe, porcentajes) {
  const total = round2(Number(importe || 0));
  const validos = normalizarPorcentajes(porcentajes);
  if (!validos) return [];
  const partes = validos.map(p => round2(total * p / 100));
  partes[partes.length - 1] = round2(total - partes.slice(0, -1).reduce((s, v) => s + v, 0));
  return partes;
}

export function dividirImporteEnDos(importe) {
  return dividirImporte(importe, [50, 50]);
}

export function nombresFraccionados(nombre, porcentajes = [50, 50]) {
  const base = String(nombre || "Proyecto").replace(/\s+\d+(?:[.,]\d+)?%\s+\d+\/\d+\s*$/i, "").trim();
  const validos = normalizarPorcentajes(porcentajes) || [50, 50];
  return validos.map((p, i) => `${base} ${String(p).replace(".", ",")}% ${i + 1}/${validos.length}`);
}

export function estaFraccionado(proyecto) {
  return Number(proyecto?.fraccion_total || 0) > 1 && Number(proyecto?.fraccion_numero || 0) > 0;
}

const aCentimos = v => Math.round(round2(Number(v) || 0) * 100);

// Resuelve un reparto en el que cada fracción se indica en % o en €.
// fracciones: [{ modo: "pct" | "eur", valor }]. Devuelve los importes y
// porcentajes definitivos, la diferencia contra el total y si es válido.
// Si todo va en %, se conserva la regla de siempre (la última absorbe el
// redondeo). Si hay importes escritos a mano se comparan en céntimos enteros,
// para que 800 + 902 = 1.702 cuadre sin errores de coma flotante.
export function resolverReparto(total, fracciones) {
  const totalC = aCentimos(total);
  const lista = (fracciones || []).map(f => ({ modo: f.modo === "eur" ? "eur" : "pct", valor: Number(String(f.valor).replace(",", ".")) }));
  const vacio = { importes: [], porcentajes: [], diferencia: totalC / 100, valido: false, soloPorcentaje: true };
  if (lista.length < 2 || lista.length > MAX_FRACCIONES || lista.some(f => !Number.isFinite(f.valor) || f.valor <= 0)) return vacio;

  if (lista.every(f => f.modo === "pct")) {
    const pcts = lista.map(f => round2(f.valor));
    const valido = round2(pcts.reduce((s, v) => s + v, 0)) === 100;
    const importes = valido ? dividirImporte(total, pcts) : pcts.map(p => round2(total * p / 100));
    const dif = totalC - importes.reduce((s, v) => s + aCentimos(v), 0);
    return { importes, porcentajes: pcts, diferencia: valido ? 0 : dif / 100, diferenciaPct: round2(100 - pcts.reduce((s, v) => s + v, 0)), valido, soloPorcentaje: true };
  }

  const importes = lista.map(f => f.modo === "eur" ? round2(f.valor) : round2(total * f.valor / 100));
  const dif = totalC - importes.reduce((s, v) => s + aCentimos(v), 0);
  const valido = totalC > 0 && dif === 0;
  const porcentajes = importes.map((imp, i) => lista[i].modo === "pct" ? round2(lista[i].valor) : (totalC > 0 ? round2(aCentimos(imp) * 100 / totalC) : 0));
  // Los % derivados pueden sumar 99,99 o 100,01 por redondeo: la última fracción
  // cuadra el 100 solo para mostrarlo (los importes mandan).
  if (valido) porcentajes[porcentajes.length - 1] = round2(100 - porcentajes.slice(0, -1).reduce((s, v) => s + v, 0));
  return { importes, porcentajes, diferencia: dif / 100, valido, soloPorcentaje: false };
}
