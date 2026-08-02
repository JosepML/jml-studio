// Google Calendar sin servidor y sin coste.
//
// Por qué así: la app es estática (GitHub Pages) y no hay backend donde
// guardar un client_secret. Google Identity Services trae un "token client"
// pensado exactamente para esto: pide un token de acceso desde el navegador,
// sin secreto, válido una hora y renovable en silencio mientras la sesión de
// Google siga viva. La API de Calendar no cuesta dinero.
//
// Lo único que hay que configurar es el ID de cliente OAuth, que NO es un
// secreto (solo funciona desde el origen autorizado) pero aun así se guarda
// en localStorage y nunca en el repositorio, igual que la clave de Gemini.

const CLAVE_ID = "jml_gcal_client_id";
const CLAVE_CALS = "jml_gcal_calendarios";
const CLAVE_TOKEN = "jml_gcal_token";
// Marca de que Google ya dio el consentimiento alguna vez en este navegador.
// Es lo que permite renovar el token en silencio sin enseñarle el botón.
const CLAVE_AUTORIZADO = "jml_gcal_autorizado";

// calendar.events = leer y escribir eventos. calendar.readonly = poder listar
// los calendarios que tiene. No se pide nada más.
const SCOPE = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly";

const BASE = "https://www.googleapis.com/calendar/v3";

let tokenClient = null;
let token = null;
let expira = 0;

/* ---------------------------------------------------------------- config */

export function clientId() {
  return (localStorage.getItem(CLAVE_ID) || "").trim();
}

export function guardarClientId(valor) {
  const v = (valor || "").trim();
  if (v) localStorage.setItem(CLAVE_ID, v);
  else localStorage.removeItem(CLAVE_ID);
  // Cambiar de ID invalida cualquier token anterior y el permiso dado.
  desconectar({ olvidarPermiso: true });
}

export function calendariosElegidos() {
  try { return JSON.parse(localStorage.getItem(CLAVE_CALS) || "[]"); }
  catch { return []; }
}

export function guardarCalendariosElegidos(ids) {
  localStorage.setItem(CLAVE_CALS, JSON.stringify(ids || []));
}

/* ------------------------------------------------------------------ auth */

function recuperarToken() {
  if (token && Date.now() < expira) return true;
  try {
    const guardado = JSON.parse(localStorage.getItem(CLAVE_TOKEN) || "null");
    if (guardado && guardado.token && Date.now() < guardado.expira) {
      token = guardado.token;
      expira = guardado.expira;
      return true;
    }
  } catch { /* nada */ }
  return false;
}

export function estaConectado() {
  return recuperarToken();
}

export function desconectar({ olvidarPermiso = false } = {}) {
  token = null;
  expira = 0;
  localStorage.removeItem(CLAVE_TOKEN);
  if (olvidarPermiso) localStorage.removeItem(CLAVE_AUTORIZADO);
}

/** ¿Ya autorizó Google en este navegador alguna vez? */
export function yaAutorizado() {
  return localStorage.getItem(CLAVE_AUTORIZADO) === "1";
}

// El script de Google se carga solo cuando hace falta, no en el index: así el
// resto de la app no depende de él ni lo descarga quien no use el calendario.
function cargarGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  const YA = "gis-script";
  let el = document.getElementById(YA);
  if (!el) {
    el = document.createElement("script");
    el.id = YA;
    el.src = "https://accounts.google.com/gsi/client";
    el.async = true;
    document.head.appendChild(el);
  }
  return new Promise((resolve, reject) => {
    let intentos = 0;
    const t = setInterval(() => {
      if (window.google?.accounts?.oauth2) { clearInterval(t); resolve(); }
      else if (++intentos > 100) { clearInterval(t); reject(new Error("No se ha podido cargar Google Identity Services.")); }
    }, 100);
  });
}

let tokenClientId = "";

/**
 * Deja el cliente de Google listo (script cargado + initTokenClient).
 * Se llama al montar la vista, ANTES de que el usuario pulse nada.
 *
 * Es imprescindible separarlo de la petición del token: el navegador solo
 * deja abrir la ventana de Google si `requestAccessToken` sale del propio
 * clic. Si primero hay que descargar el script de Google, para cuando se
 * llama ya se ha perdido el gesto y Chrome responde `popup_failed_to_open`.
 */
export async function preparar() {
  const id = clientId();
  if (!id) throw new Error("Falta el ID de cliente de Google (Configuración → Calendario).");
  await cargarGis();
  if (!tokenClient || tokenClientId !== id) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: id,
      scope: SCOPE,
      callback: () => {},   // se reasigna en cada petición
    });
    tokenClientId = id;
  }
}

/** Pide el token. SIN await previo: tiene que ir pegado al clic. */
export function pedirToken({ silencioso = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!tokenClient) { reject(new Error("Google todavía no está listo. Inténtalo otra vez.")); return; }
    tokenClient.callback = (res) => {
      if (res.error) { reject(new Error(res.error_description || res.error)); return; }
      token = res.access_token;
      localStorage.setItem(CLAVE_AUTORIZADO, "1");
      // 60 s de margen para no usar un token que caduca a mitad de petición.
      expira = Date.now() + ((Number(res.expires_in) || 3600) - 60) * 1000;
      try { localStorage.setItem(CLAVE_TOKEN, JSON.stringify({ token, expira })); } catch { /* nada */ }
      resolve(token);
    };
    tokenClient.error_callback = (err) => reject(new Error(err?.type || "Ventana de Google cerrada."));
    try {
      tokenClient.requestAccessToken({ prompt: silencioso ? "none" : "" });
    } catch (e) { reject(e); }
  });
}

/**
 * Renueva el token aprovechando el PRIMER clic que haga el usuario, sea donde
 * sea, sin enseñarle ningún botón.
 *
 * Por qué así: Google no permite renovar de verdad en silencio en un flujo sin
 * servidor. Se probaron las dos vías (`prompt: "none"` y con `hint` de la
 * cuenta) y las dos responden `popup_failed_to_open`: la petición SIEMPRE
 * tiene que salir de un gesto del usuario. Y el token solo dura una hora.
 *
 * La salida es esta: se queda un oyente esperando su primer clic en cualquier
 * parte de la app y ahí se pide el token con `prompt: "none"`. Como el permiso
 * ya está concedido, Google no pregunta nada; a lo sumo se ve una ventana que
 * se abre y se cierra sola. Él no ha tenido que pulsar ningún "Conectar".
 *
 * Devuelve el token, o null si hace falta que pulse él de verdad (sesión de
 * Google cerrada, cookies borradas o permiso nunca concedido).
 */
export async function reconectarSilencio({ esperarClic = true } = {}) {
  if (recuperarToken()) return token;
  if (!clientId() || !yaAutorizado()) return null;
  try {
    await preparar();
    if (!esperarClic) return await pedirToken({ silencioso: true });
    return await enPrimerClic();
  } catch {
    return null;
  }
}

// Un solo oyente global por intento: si se llama dos veces (dos vistas, o una
// recarga del calendario) se reutiliza la misma promesa en vez de encadenar
// varias peticiones al mismo clic.
let esperaClic = null;

function enPrimerClic() {
  if (esperaClic) return esperaClic;
  esperaClic = new Promise((resolve) => {
    const alClicar = () => {
      // Nada de await aquí dentro: el gesto se pierde y Google contesta
      // popup_failed_to_open. Es el mismo motivo por el que preparar() y
      // pedirToken() están separados.
      pedirToken({ silencioso: true })
        .then(t => { esperaClic = null; resolve(t); })
        .catch(() => { esperaClic = null; resolve(null); });
    };
    document.addEventListener("click", alClicar, { once: true, capture: true });
  });
  return esperaClic;
}

/** Camino completo: preparar + pedir. Para cuando no hay prisa por el gesto. */
export async function conectar(opciones = {}) {
  if (recuperarToken()) return token;
  // Antes de rendirse, el intento silencioso: así una llamada a la API que
  // pilla el token recién caducado se recupera sola en vez de dar error.
  const t = await reconectarSilencio({ esperarClic: false });
  if (t) return t;
  await preparar();
  return pedirToken(opciones);
}

/* ------------------------------------------------------------------- api */

async function api(ruta, opciones = {}) {
  const t = await conectar();
  const res = await fetch(BASE + ruta, {
    ...opciones,
    headers: {
      Authorization: `Bearer ${t}`,
      ...(opciones.body ? { "Content-Type": "application/json" } : {}),
      ...(opciones.headers || {}),
    },
  });
  if (res.status === 401) {
    desconectar();
    throw new Error("La sesión con Google ha caducado. Vuelve a conectar.");
  }
  if (!res.ok) {
    let msg = `Google ha respondido ${res.status}`;
    try { const j = await res.json(); msg = j?.error?.message || msg; } catch { /* nada */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

export async function listarCalendarios() {
  const j = await api("/users/me/calendarList?minAccessRole=writer&maxResults=100");
  return (j.items || []).map(c => ({
    id: c.id,
    nombre: c.summaryOverride || c.summary,
    color: c.backgroundColor || "#4C6FFF",
    principal: !!c.primary,
  }));
}

function aFecha(punto) {
  // Google manda dateTime (con hora) o date (día completo).
  if (punto.dateTime) return new Date(punto.dateTime);
  const [a, m, d] = punto.date.split("-").map(Number);
  return new Date(a, m - 1, d);
}

function normalizar(ev, cal) {
  return {
    id: ev.id,
    calendarId: cal.id,
    calendarNombre: cal.nombre,
    color: cal.color,
    titulo: ev.summary || "(sin título)",
    descripcion: ev.description || "",
    lugar: ev.location || "",
    todoElDia: !ev.start?.dateTime,
    inicio: aFecha(ev.start),
    fin: aFecha(ev.end),
    enlace: ev.htmlLink || "",
  };
}

/**
 * Eventos de todos los calendarios elegidos entre dos fechas.
 * Devuelve ya la lista aplanada y ordenada por hora de inicio.
 */
export async function listarEventos(desde, hasta, calendarios) {
  const cals = calendarios && calendarios.length ? calendarios : await listarCalendarios();
  const elegidos = calendariosElegidos();
  const usar = elegidos.length ? cals.filter(c => elegidos.includes(c.id)) : cals;

  const tandas = await Promise.all(usar.map(async (cal) => {
    const q = new URLSearchParams({
      timeMin: desde.toISOString(),
      timeMax: hasta.toISOString(),
      singleEvents: "true",       // las series se expanden en sus repeticiones
      orderBy: "startTime",
      maxResults: "250",
    });
    try {
      const j = await api(`/calendars/${encodeURIComponent(cal.id)}/events?${q}`);
      return (j.items || []).filter(e => e.status !== "cancelled").map(e => normalizar(e, cal));
    } catch {
      return [];   // un calendario que falle no puede tumbar el mes entero
    }
  }));

  return tandas.flat().sort((a, b) => a.inicio - b.inicio);
}

export function crearEvento(calendarId, cuerpo) {
  return api(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: "POST",
    body: JSON.stringify(cuerpo),
  });
}

export function actualizarEvento(calendarId, eventoId, cuerpo) {
  return api(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventoId)}`, {
    method: "PATCH",
    body: JSON.stringify(cuerpo),
  });
}

export function borrarEvento(calendarId, eventoId) {
  return api(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventoId)}`, {
    method: "DELETE",
  });
}

/* --------------------------------------------------------------- ayudas */

/** "2026-08-01" a partir de un Date, en hora local (nada de toISOString). */
export function iso(fecha) {
  const m = String(fecha.getMonth() + 1).padStart(2, "0");
  const d = String(fecha.getDate()).padStart(2, "0");
  return `${fecha.getFullYear()}-${m}-${d}`;
}

/** "14:30" a partir de un Date. */
export function hhmm(fecha) {
  return `${String(fecha.getHours()).padStart(2, "0")}:${String(fecha.getMinutes()).padStart(2, "0")}`;
}

/**
 * Construye el cuerpo que espera Google a partir del formulario.
 * Con día completo, `end.date` es EXCLUSIVO: un evento de un solo día acaba
 * al día siguiente. Es el error clásico de esta API.
 */
export function cuerpoEvento({ titulo, todoElDia, fechaIni, horaIni, fechaFin, horaFin, lugar, descripcion }) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Madrid";
  if (todoElDia) {
    const fin = new Date(`${fechaFin || fechaIni}T00:00:00`);
    fin.setDate(fin.getDate() + 1);
    return {
      summary: titulo,
      location: lugar || undefined,
      description: descripcion || undefined,
      start: { date: fechaIni },
      end: { date: iso(fin) },
    };
  }
  return {
    summary: titulo,
    location: lugar || undefined,
    description: descripcion || undefined,
    start: { dateTime: new Date(`${fechaIni}T${horaIni || "09:00"}:00`).toISOString(), timeZone: tz },
    end: { dateTime: new Date(`${fechaFin || fechaIni}T${horaFin || horaIni || "10:00"}:00`).toISOString(), timeZone: tz },
  };
}
