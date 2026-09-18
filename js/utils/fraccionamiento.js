import { round2 } from "./invoice-calc.js";

export const TOTAL_FRACCIONES = 2;

export function dividirImporteEnDos(importe) {
  const total = round2(Number(importe || 0));
  const primera = round2(total / 2);
  return [primera, round2(total - primera)];
}

export function nombresFraccionados(nombre) {
  const base = String(nombre || "Proyecto").replace(/\s+50%\s+[12]\/2\s*$/i, "").trim();
  return [`${base} 50% 1/2`, `${base} 50% 2/2`];
}

export function estaFraccionado(proyecto) {
  return Number(proyecto?.fraccion_total || 0) > 1 && Number(proyecto?.fraccion_numero || 0) > 0;
}
