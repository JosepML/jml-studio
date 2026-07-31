// Ajustes personales de Josep que cambian con el tiempo (porcentaje del
// Modelo 130, cuota de autónomo, honorarios de gestoría, clave de la IA...).
// Antes estaban escritos a fuego en el código (p. ej. "20%" o "88.56€"); ahora
// viven aquí, editables desde Configuración, para no tener que volver a tocar
// código cada vez que cambien (p. ej. al pasar de cuota reducida a cuota
// normal, o al subir el IRPF el año que viene).
//
// Se guardan en localStorage (por dispositivo) en vez de en Supabase: así la
// clave de la IA nunca sale del navegador ni pasa por el repositorio de
// GitHub, que es público. Si Josep cambia de dispositivo, solo tiene que
// volver a rellenar Configuración una vez en ese dispositivo nuevo.
const LS_KEY = "jml_config_usuario";

export const DEFAULTS = {
  // % de pago fraccionado trimestral (Modelo 130) sobre el rendimiento neto
  // del propio trimestre (sin acumular con trimestres anteriores). El
  // estándar general es 20%, pero los autónomos con cuota reducida u otras
  // circunstancias pueden tener un porcentaje distinto — confírmalo con tu
  // gestoría si cambia.
  modelo130_pct: 7,
  // Gasto fijo mensual: cuota de autónomo a la Seguridad Social (actualmente
  // en tarifa/cuota reducida).
  cuota_autonomo_importe: 88.56,
  // Gasto fijo mensual: honorarios de la gestoría (con IVA).
  gestoria_importe: 60.71,
  gestoria_iva_soportado: 10.54,
  // Clave de API gratuita de Google Gemini (aistudio.google.com) para el
  // botón "Mejorar con IA" de las descripciones de presupuesto. Vacía por
  // defecto: sin clave, ese botón se desactiva y lo explica.
  gemini_api_key: "",
  // Biblioteca de condiciones adicionales para los presupuestos. Son las que
  // Josep repite de un presupuesto a otro (láseres, time-code...) y que no
  // están entre las condiciones fijas de config-negocio.js. Vive aquí, en
  // localStorage, para no necesitar tabla propia: son plantillas de texto,
  // no datos fiscales.
  condiciones_biblioteca: [
    "El uso de láseres durante el evento puede dañar los sensores de las cámaras e impediría por completo la grabación en los momentos en que estén activos.",
    "Si las cámaras aportadas por terceros no graban con time-code, el trabajo de sincronización en postproducción aumenta y el precio de la edición podría verse incrementado.",
  ],
};

export function getConfig() {
  let guardado = {};
  try { guardado = JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { guardado = {}; }
  return { ...DEFAULTS, ...guardado };
}

export function setConfig(parcial) {
  const actual = getConfig();
  const nuevo = { ...actual, ...parcial };
  localStorage.setItem(LS_KEY, JSON.stringify(nuevo));
  return nuevo;
}

// --- Biblioteca de condiciones para presupuestos ---
// Se guardan como textos sueltos; el orden es el de la lista.
export function getCondicionesBiblioteca() {
  const c = getConfig().condiciones_biblioteca;
  return Array.isArray(c) ? c : DEFAULTS.condiciones_biblioteca;
}

// Añade una condición nueva si no existe ya (comparando sin espacios ni
// mayúsculas, para no llenar la biblioteca de casi-duplicados).
export function anadirCondicionBiblioteca(texto) {
  const limpio = String(texto || "").trim();
  if (!limpio) return getCondicionesBiblioteca();
  const actuales = getCondicionesBiblioteca();
  const yaEsta = actuales.some(c => c.trim().toLowerCase() === limpio.toLowerCase());
  const nuevas = yaEsta ? actuales : [...actuales, limpio];
  setConfig({ condiciones_biblioteca: nuevas });
  return nuevas;
}

export function eliminarCondicionBiblioteca(texto) {
  const nuevas = getCondicionesBiblioteca().filter(c => c !== texto);
  setConfig({ condiciones_biblioteca: nuevas });
  return nuevas;
}
