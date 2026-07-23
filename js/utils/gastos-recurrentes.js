import { db } from "../supabase.js";

// Gastos fijos que Josep paga religiosamente todos los meses (cuota de
// autónomo a la Seguridad Social y honorarios de la gestoría) y que antes
// tenía que dar de alta él mismo cada mes en Gastos. Con esto se generan
// solos: cada vez que abre la app se comprueba si falta alguno desde enero
// del año en curso hasta el mes actual (incluido) y se crea con el mismo
// importe/categoría/IVA que ha usado siempre, para que no tenga que volver a
// añadirlos a mano. Los importes están sacados de sus propios gastos ya
// registrados (Gestoría - honorarios mensuales / Seguridad Social autonomos).
const PLANTILLAS = [
  {
    // Mismo texto todos los meses (no lleva el mes en el concepto).
    concepto: "Gestoría - honorarios mensuales",
    conceptoConMes: false,
    importe: 60.71,
    ivaSoportado: 10.54,
    categoria: "servicios",
  },
  {
    // "Seguridad Social autonomos - MM/YYYY"
    concepto: "Seguridad Social autonomos",
    conceptoConMes: true,
    importe: 88.56,
    ivaSoportado: 0,
    categoria: "fijo",
  },
];

// Día del mes calculado con aritmética local pura (sin pasar por Date/UTC)
// para evitar el clásico desfase de -1 día al convertir con toISOString().
function ultimoDiaMes(anio, mesIndex0) {
  const ultimoDia = new Date(anio, mesIndex0 + 1, 0).getDate();
  return `${anio}-${String(mesIndex0 + 1).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;
}

function mesKey(fechaIso) {
  return String(fechaIso || "").slice(0, 7); // "YYYY-MM"
}

// Comprueba y, si hace falta, crea los gastos fijos recurrentes que falten
// este año hasta el mes actual. Se puede llamar en cada arranque de la app:
// no duplica nada porque primero mira qué meses ya existen.
export async function asegurarGastosFijosMensuales() {
  const hoy = new Date();
  const anio = hoy.getFullYear();
  const mesActual = hoy.getMonth(); // 0-indexed, incluido

  const { data: existentes, error } = await db.from("gastos")
    .select("concepto,fecha")
    .gte("fecha", `${anio}-01-01`)
    .lte("fecha", `${anio}-12-31`)
    .exec();
  if (error) { console.error("No se pudieron comprobar los gastos fijos recurrentes:", error); return; }

  const nuevos = [];
  for (const plantilla of PLANTILLAS) {
    for (let mes = 0; mes <= mesActual; mes++) {
      const claveMes = `${anio}-${String(mes + 1).padStart(2, "0")}`;
      const conceptoMes = plantilla.conceptoConMes
        ? `${plantilla.concepto} - ${String(mes + 1).padStart(2, "0")}/${anio}`
        : plantilla.concepto;
      const yaExiste = (existentes || []).some(g => g.concepto === conceptoMes && mesKey(g.fecha) === claveMes);
      if (yaExiste) continue;
      nuevos.push({
        concepto: conceptoMes,
        importe: plantilla.importe,
        tipo: "fijo",
        fecha: ultimoDiaMes(anio, mes),
        categoria: plantilla.categoria,
        deducible: true,
        con_factura: true,
        iva_soportado: plantilla.ivaSoportado,
        iva_deducible_pct: 100,
        es_amortizable: false,
        recurrente: true,
      });
    }
  }
  if (!nuevos.length) return;
  const { error: errInsert } = await db.from("gastos").insert(nuevos).exec();
  if (errInsert) console.error("Error creando gastos fijos recurrentes:", errInsert);
}
