export function eur(n) {
  const v = Number(n || 0);
  return v.toLocaleString("es-ES", { style: "currency", currency: "EUR" });
}
export function dateEs(iso) {
  if (!iso) return "—";
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" });
}
export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
export function quarterOf(dateIso) {
  const m = new Date(dateIso).getMonth(); // 0-11
  return Math.floor(m / 3) + 1; // 1-4
}
export const ESTADOS_PROYECTO = {
  presupuestado: { label: "Presupuestado", bg: "#FDEBD8", fg: "#B4571C" },
  en_curso:      { label: "En curso",      bg: "#E3F1EA", fg: "#2E7D53" },
  en_revision:   { label: "En revisión",   fg: "#33499E", bg: "#E7ECFB" },
  cobrado:       { label: "Cobrado",       bg: "#E3F1EA", fg: "#2E7D53" },
};
export const ESTADOS_FACTURA = {
  borrador: { label: "Borrador", bg: "#F0F1F4", fg: "#5B6478" },
  emitida:  { label: "Emitida",  bg: "#FFF3D6", fg: "#8A6A10" },
  pagada:   { label: "Pagada",   bg: "#E3F1EA", fg: "#2E7D53" },
  vencida:  { label: "Vencida",  bg: "#FDEBD8", fg: "#B4571C" },
};
