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

export function tieneClaveIA() {
  return !!getConfig().ia_api_key;
}

async function chat(mensajes, { temperature = 0.4, maxTokens = 600 } = {}) {
  const { ia_api_key } = getConfig();
  if (!ia_api_key) throw new Error("Falta la clave de IA — añádela en Configuración → IA.");

  const res = await fetch(URL_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ia_api_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODELO,
      messages: mensajes,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // La capa gratuita va limitada a pocas peticiones por minuto: merece la
    // pena decirlo con palabras en vez de soltar un 429 a secas.
    if (res.status === 429) throw new Error("Demasiadas peticiones seguidas. Espera unos segundos y vuelve a probar.");
    if (res.status === 401) throw new Error("La clave de IA no es válida. Revísala en Configuración → IA.");
    throw new Error(data?.message || data?.error?.message || `Error ${res.status} llamando a la IA.`);
  }

  const texto = (data?.choices?.[0]?.message?.content || "").trim();
  if (!texto) throw new Error("La IA no ha devuelto ninguna respuesta.");
  return texto;
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
