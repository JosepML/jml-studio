// Catálogo de tarifas ("servicios"): "Grabación media jornada — 390 €",
// "Grabación jornada completa — 690 €", "Edición express — 450 €"…
//
// Existe para no volver a teclear el mismo concepto con un precio distinto cada
// vez. Desde el editor de facturas y presupuestos se insertan de un clic.
//
// Vive en Supabase (tabla `servicios`, migración 005) y no en localStorage
// porque son datos de negocio: tienen que estar igual en el móvil y en el
// ordenador y no deben perderse al limpiar el navegador. La biblioteca de
// condiciones sí está en localStorage, pero eso son plantillas de texto, no
// tarifas.

import { db } from "../supabase.js";

// Los inactivos no se ofrecen en el editor, pero no se borran: un servicio
// retirado seguiría apareciendo en los documentos antiguos y borrarlo dejaría
// el histórico sin explicación.
export async function listarServicios({ soloActivos = false } = {}) {
  const q = db.from("servicios").select("*").order("orden");
  if (soloActivos) q.eq("activo", true);
  const { data, error } = await q.exec();
  if (error) return { data: [], error };
  // Orden secundario por nombre: `orden` empieza en 0 para todos, así que sin
  // esto la lista saldría en un orden arbitrario hasta que se reordene a mano.
  const lista = (data || []).slice().sort((a, b) =>
    (a.orden - b.orden) || String(a.nombre || "").localeCompare(String(b.nombre || ""), "es")
  );
  return { data: lista, error: null };
}

export async function crearServicio({ nombre, descripcion = "", precio = 0, unidad = "", categoria_servicio = null, orden = 0 }) {
  return db.from("servicios").insert({
    nombre: String(nombre || "").trim(),
    descripcion: String(descripcion || "").trim() || null,
    precio: Number(precio || 0),
    unidad: String(unidad || "").trim() || null,
    categoria_servicio: categoria_servicio || null,
    activo: true,
    orden: Number(orden || 0),
  }).exec();
}

export async function actualizarServicio(id, cambios) {
  return db.from("servicios").update(cambios).eq("id", id).exec();
}

export async function borrarServicio(id) {
  return db.from("servicios").delete().eq("id", id).exec();
}

// Texto que se muestra en el desplegable del editor. La unidad va entre
// paréntesis solo si existe, para que "Grabación (jornada) — 690 €" no se
// convierta en "Grabación () — 690 €" cuando no se ha rellenado.
export function etiquetaServicio(s) {
  const unidad = String(s.unidad || "").trim();
  return `${s.nombre}${unidad ? ` (${unidad})` : ""}`;
}

// Convierte una tarifa en una línea de documento. La descripción del servicio
// se copia al crear la línea, no se referencia: así editarla en el catálogo no
// reescribe presupuestos ya emitidos.
export function servicioALinea(s) {
  return {
    concepto: s.nombre || "",
    descripcion: s.descripcion || "",
    cantidad: 1,
    precio: Number(s.precio || 0),
    proyecto_id: "",
    descuento_tipo: "porcentaje",
    descuento_valor: 0,
  };
}
