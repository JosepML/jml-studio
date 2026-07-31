// Datos del emisor (los que salen en facturas y presupuestos).
//
// IMPORTANTE: aquí NO hay datos reales. El NIF, la dirección, el teléfono y el
// IBAN estaban escritos a fuego en este fichero y el repositorio de GitHub es
// público, así que cualquiera podía leerlos sin pasar por la app. Desde la
// migración 008 viven en Supabase (tabla `emisor`, con RLS): solo se pueden
// leer con la sesión iniciada.
//
// Para no volver asíncrono a medio proyecto (facturacion.js y pdf-documentos.js
// leen `CONFIG_NEGOCIO.emisor` de forma síncrona), se cargan una vez al entrar
// —`cargarEmisor()` desde app.js— y se guarda una copia en localStorage para
// que un recargo o el modo sin conexión no dejen el PDF sin IBAN.

import { db, auth } from "../supabase.js";

const LS_KEY = "jml_config_usuario";   // ajustes de Configuración (por dispositivo)
const LS_CACHE = "jml_emisor_cache";   // copia local de lo que hay en Supabase

// Estructura, no datos: sirve para que el PDF no rompa si algo falta.
const EMISOR_BASE = {
  nombre: "", actividad: "", nif: "",
  direccion_linea1: "", direccion_linea2: "",
  email: "", telefono: "", iban: "", bic: "",
  logo: "assets/logo.png",
};

let EMISOR_REMOTO = leerCache();

function leerCache() {
  try { return JSON.parse(localStorage.getItem(LS_CACHE) || "{}"); } catch { return {}; }
}

// Solo los campos rellenados en Configuración: un campo en blanco no debe
// borrar el valor bueno por accidente.
function sobrescriturasEmisor() {
  try {
    const guardado = JSON.parse(localStorage.getItem(LS_KEY) || "{}").emisor || {};
    return Object.fromEntries(
      Object.entries(guardado).filter(([, v]) => String(v ?? "").trim() !== "")
    );
  } catch {
    return {};
  }
}

// Se llama al arrancar con sesión iniciada. Si falla (sin red), se sigue con la
// copia de localStorage.
export async function cargarEmisor() {
  const { data, error } = await db.from("emisor").select("datos").single().exec();
  if (error || !data?.datos) return;
  EMISOR_REMOTO = data.datos;
  try { localStorage.setItem(LS_CACHE, JSON.stringify(EMISOR_REMOTO)); } catch {}
}

// Guarda en Supabase lo que se edite en Configuración.
export async function guardarEmisor(datos) {
  const limpio = Object.fromEntries(
    Object.entries(datos || {}).filter(([, v]) => String(v ?? "").trim() !== "")
  );
  EMISOR_REMOTO = { ...EMISOR_REMOTO, ...limpio };
  try { localStorage.setItem(LS_CACHE, JSON.stringify(EMISOR_REMOTO)); } catch {}
  const uid = auth.currentUser()?.id;
  if (!uid) return { error: "sin sesión" };
  return db.from("emisor").update({ datos: EMISOR_REMOTO }).eq("user_id", uid).exec();
}

// Borra la copia local al cerrar sesión: los datos fiscales no deben quedarse
// en un navegador prestado.
export function olvidarEmisor() {
  EMISOR_REMOTO = {};
  try { localStorage.removeItem(LS_CACHE); } catch {}
}

export const CONFIG_NEGOCIO = {
  // Getter a propósito: se recalcula en cada acceso, así facturacion.js y
  // pdf-documentos.js recogen lo que se acabe de cargar o guardar sin cambios.
  get emisor() {
    return { ...EMISOR_BASE, ...EMISOR_REMOTO, ...sobrescriturasEmisor() };
  },
  fiscal: { iva_pct: 21, retencion_pct: 0 },
};

// Campos editables desde Configuración. El logo se queda fuera: es un fichero
// del repositorio, no un dato de texto.
export const CAMPOS_EMISOR = [
  { clave: "nombre", label: "Nombre y apellidos" },
  { clave: "nif", label: "NIF" },
  { clave: "actividad", label: "Actividad" },
  { clave: "direccion_linea1", label: "Dirección" },
  { clave: "direccion_linea2", label: "CP y población" },
  { clave: "email", label: "Email" },
  { clave: "telefono", label: "Teléfono" },
  { clave: "iban", label: "IBAN" },
  { clave: "bic", label: "BIC / SWIFT" },
];

export { EMISOR_BASE };
