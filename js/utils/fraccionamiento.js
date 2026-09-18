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
