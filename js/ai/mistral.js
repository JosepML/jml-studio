// IA de la app: Mistral (Francia), llamada directa desde el navegador.
//
// Por qué Mistral y no Gemini: Google no permite usar su capa gratuita a
// usuarios de España/UE, así que la clave era correcta pero toda petición
// devolvía error de cuota. Mistral tiene una capa gratuita de verdad
// ("Experiment"), sin tarjeta, disponible aquí — y al ser una empresa
// europea, los datos del contexto (clientes, importes) no salen de la UE.
//
// Su API acepta peticiones desde el navegador (comprobado: responde con
// cabeceras CORS), así que no hace falta servidor. La clave la pone Josep en
// Configuración y vive solo en su localStorage, nunca en el repositorio.
import { getConfig } from "../utils/config-usuario.js";

const URL_API = "https://api.mistral.ai/v1/chat/completions";
const MODELO = "mistral-small-latest";
const REINTENTOS_MAXIMOS = 2;

function pausa(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mensajeDeError(data) {
  if (typeof data === "string") return data;
  return data?.message || data?.error?.message || data?.error || data?.detail || "";
}

function errorDeRespuesta(res, data) {
  const detalle = mensajeDeError(data);

  if (res.status === 401) {
    return new Error("La clave de Mistral no es válida o ha caducado. Crea una nueva en Configuración → IA y pulsa «Probar».");
  }
  if (res.status === 402) {
    return new Error("Se ha agotado el uso incluido de Mistral. Entra en Mistral Studio para revisar los límites o activar saldo y vuelve a probar.");
  }
  if (res.status === 403) {
    return new Error("Esta clave no tiene permiso para usar el modelo de IA. Crea una clave nueva en Mistral Studio y guárdala en Configuración → IA.");
  }
  if (res.status === 404) {
    return new Error("El modelo de IA ya no está disponible para esta clave. Comprueba la clave en Configuración → IA.");
  }
  if (res.status >= 500) {
    return new Error("Mistral está teniendo un problema temporal. Espera un momento y vuelve a intentarlo.");
  }
  return new Error(detalle || `Error ${res.status} llamando a la IA.`);
}

export function tieneClaveIA() {
  return !!getConfig().ia_api_key;
}

async function chat(mensajes, { temperature = 0.4, maxTokens = 600 } = {}) {
  const { ia_api_key } = getConfig();
  if (!ia_api_key) throw new Error("Falta la clave de IA — añádela en Configuración → IA.");

  for (let intento = 0; intento <= REINTENTOS_MAXIMOS; intento++) {
    const controlador = new AbortController();
    const tiempoMaximo = setTimeout(() => controlador.abort(), 30000);
    let res;

    try {
      res = await fetch(URL_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ia_api_key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: MODELO,
          messages: mensajes,
          temperature,
          max_tokens: maxTokens,
        }),
        signal: controlador.signal,
      });
    } catch (e) {
      if (e?.name === "AbortError") throw new Error("La IA ha tardado demasiado en responder. Comprueba tu conexión y vuelve a intentarlo.");
      throw new Error("No se ha podido conectar con Mistral. Comprueba tu conexión e inténtalo de nuevo.");
    } finally {
      clearTimeout(tiempoMaximo);
    }

    const data = await res.json().catch(async () => ({ detail: await res.text().catch(() => "") }));
    if (res.ok) {
      const texto = (data?.choices?.[0]?.message?.content || "").trim();
      if (!texto) throw new Error("La IA no ha devuelto ninguna respuesta.");
      return texto;
    }

    // El modo gratuito limita las ráfagas. Reintentamos una vez de forma
    // transparente, respetando Retry-After cuando el servicio lo proporciona.
    if (res.status === 429 && intento < REINTENTOS_MAXIMOS) {
      const esperaIndicada = Number(res.headers.get("Retry-After"));
      const espera = Number.isFinite(esperaIndicada) && esperaIndicada > 0
        ? Math.min(esperaIndicada * 1000, 8000)
        : (intento + 1) * 1500;
      await pausa(espera);
      continue;
    }

    if (res.status === 429) throw new Error("Mistral está recibiendo demasiadas peticiones. Espera un minuto y vuelve a probar.");
    throw errorDeRespuesta(res, data);
  }
}

/* ------------------------------------------------- mejorar descripciones */

// Convierte una nota breve del propio Josep (p. ej. "grabación 4h pista
// padel") en una descripción de servicio más formal para un presupuesto,
// usando también el concepto de la línea como contexto.
export async function mejorarDescripcionConIA(concepto, notaBreve) {
  if (!notaBreve || !notaBreve.trim()) throw new Error("Escribe primero una nota breve para que la IA la mejore.");

  const texto = await chat([
    {
      role: "system",
      content: "Eres el redactor de presupuestos de un profesional autónomo de producción audiovisual (vídeo, fotografía, eventos). Devuelve SOLO una descripción de servicio en español, clara y profesional, de una o dos frases, sin comillas ni prefijos, lista para aparecer tal cual en el PDF que verá el cliente. No inventes datos (precios, fechas, cantidades) que no estén en la nota.",
    },
    {
      role: "user",
      content: `Concepto de la línea: "${concepto || "Servicio"}"\nNota breve del autónomo: "${notaBreve.trim()}"`,
    },
  ], { temperature: 0.4, maxTokens: 200 });

  return texto.replace(/^["“]|["”]$/g, "").trim();
}

/* ------------------------------------------------------ chat financiero */

const INSTRUCCION_ASISTENTE = `Eres el asistente financiero personal de Josep, autónomo de producción audiovisual en España (estimación directa simplificada, régimen general de IVA). Te paso un resumen JSON con sus cifras reales: facturación, gastos, Modelo 130, clientes, etc. Responde SIEMPRE en español, de forma breve, concreta y práctica, apoyándote en esos datos. Si te pregunta algo que no puedas calcular con la información dada, dilo claramente en vez de inventar cifras. No des nunca asesoramiento fiscal o legal como si fuera definitivo — cuando sea relevante, recuérdale que lo confirme con su gestoría antes de actuar.`;

export async function preguntarAsistenteFinanciero(pregunta, contexto, historial) {
  if (!pregunta || !pregunta.trim()) throw new Error("Escribe una pregunta.");

  const mensajes = [
    { role: "system", content: `${INSTRUCCION_ASISTENTE}\n\nDATOS FINANCIEROS ACTUALES (JSON):\n${JSON.stringify(contexto)}` },
    ...(historial || [])
      .filter(m => !m.pensando && !m.error)
      .map(m => ({ role: m.rol === "usuario" ? "user" : "assistant", content: m.texto })),
    { role: "user", content: pregunta.trim() },
  ];

  return chat(mensajes, { temperature: 0.3, maxTokens: 600 });
}
