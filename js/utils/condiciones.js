// Condiciones de los presupuestos, en una sola lista editable.
//
// Antes vivían en DOS sitios y eso era el problema: tres condiciones escritas a
// fuego en config-negocio.js que el PDF imprimía SIEMPRE, más una biblioteca en
// localStorage que sí se elegía por documento. Consecuencia: un presupuesto de
// solo grabación hablaba de "la postproducción del episodio" y no había manera
// de quitarlo sin editar código.
//
// Ahora todas están en la tabla `condiciones` (migración 006). `por_defecto`
// marca las que se añaden solas a un presupuesto nuevo, pero ninguna es
// obligatoria: en el documento se pueden quitar y reescribir una a una, y el
// PDF imprime solo lo que ese documento lleva guardado.

import { db } from "../supabase.js";

export async function listarCondiciones({ soloActivas = false } = {}) {
  const q = db.from("condiciones").select("*").order("orden");
  if (soloActivas) q.eq("activo", true);
  const { data, error } = await q.exec();
  if (error) return { data: [], error };
  // `orden` empieza igual para varias, así que se desempata por texto para que
  // la lista no baile de una carga a otra.
  const lista = (data || []).slice().sort((a, b) =>
    (a.orden - b.orden) || String(a.texto || "").localeCompare(String(b.texto || ""), "es")
  );
  return { data: lista, error: null };
}

export async function crearCondicion({ texto, grupo = "generales", por_defecto = false, orden = 0 }) {
  return db.from("condiciones").insert({
    texto: String(texto || "").trim(),
    grupo,
    por_defecto: !!por_defecto,
    activo: true,
    orden: Number(orden || 0),
  }).exec();
}

export async function actualizarCondicion(id, cambios) {
  return db.from("condiciones").update(cambios).eq("id", id).exec();
}

export async function borrarCondicion(id) {
  return db.from("condiciones").delete().eq("id", id).exec();
}

// Los tres grupos del anexo de condiciones. Las "generales" aplican a todo
// presupuesto; las de rodaje y postproducción se añaden en pack según lo que
// cubra el trabajo, porque un presupuesto de solo grabación no debe hablar de
// rondas de revisión ni uno de solo edición de entrega de brutos.
export const GRUPOS_CONDICION = {
  generales: "Generales",
  rodaje: "Rodaje / grabación",
  postproduccion: "Postproducción",
};

function activasDe(lista, grupo, soloFijas) {
  return (lista || [])
    .filter(c => c.activo !== false)
    .filter(c => (c.grupo || "generales") === grupo)
    .filter(c => !soloFijas || c.por_defecto)
    .map(c => c.texto);
}

// Lo que se precarga en un presupuesto nuevo: solo las generales fijas. Los
// packs de rodaje y postproducción se añaden a mano, que es la decisión que
// depende del proyecto. Se devuelven como cadenas, no referencias: el documento
// guarda su propia copia, así que retocar el texto de un presupuesto no toca la
// plantilla ni al contrario.
export function textosPorDefecto(lista) {
  return activasDe(lista, "generales", true);
}

// Las fijas de un grupo, para el botón de pack.
export function textosFijasDeGrupo(lista, grupo) {
  return activasDe(lista, grupo, true);
}
