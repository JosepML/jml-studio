// Llamada directa (sin backend) a la API gratuita de Google Gemini, usada por
// el botón "Mejorar con IA" de las descripciones de línea en Presupuestos.
// La clave la pone Josep en Configuración y se queda solo en su navegador
// (localStorage) — nunca se sube al repositorio.
import { getConfig } from "../utils/config-usuario.js";

const MODELO = "gemini-2.0-flash";

export function tieneClaveGemini() {
  return !!getConfig().gemini_api_key;
}

// Convierte una nota breve del propio Josep (p. ej. "grabación 4h pista
// padel") en una descripción de servicio más formal para un presupuesto,
// usando también el concepto de la línea como contexto.
export async function mejorarDescripcionConIA(concepto, notaBreve) {
  const { gemini_api_key } = getConfig();
  if (!gemini_api_key) throw new Error("Falta la clave de Gemini — añádela en Configuración.");
  if (!notaBreve || !notaBreve.trim()) throw new Error("Escribe primero una nota breve para que la IA la mejore.");

  const prompt = `Eres el redactor de presupuestos de un profesional autónomo de producción audiovisual (vídeo, fotografía, eventos). Te doy el concepto de una línea de un presupuesto y una nota breve del propio autónomo describiendo el servicio. Devuelve SOLO una descripción de servicio en español, clara y profesional, de una o dos frases, sin comillas ni prefijos, lista para aparecer tal cual en el PDF del presupuesto que verá el cliente. No inventes datos (precios, fechas, cantidades) que no estén en la nota.

Concepto de la línea: "${concepto || "Servicio"}"
Nota breve del autónomo: "${notaBreve.trim()}"

Descripción:`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${encodeURIComponent(gemini_api_key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 200 },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Error ${res.status} llamando a Gemini`;
    throw new Error(msg);
  }
  const texto = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
  if (!texto) throw new Error("Gemini no ha devuelto ninguna descripción.");
  return texto.replace(/^["“]|["”]$/g, "").trim();
}

// Chat del Asistente: responde preguntas sobre el negocio de Josep usando sus
// cifras reales (facturación, gastos, Modelo 130, clientes...) como contexto.
// Misma clave gratuita de Gemini que "Mejorar con IA" — nunca sale del
// navegador salvo hacia la propia API de Google.
const INSTRUCCION_ASISTENTE = `Eres el asistente financiero personal de Josep, autónomo de producción audiovisual en España (estimación directa simplificada, régimen general de IVA). Te paso un resumen JSON con sus cifras reales: facturación, gastos, Modelo 130, clientes, etc. Responde SIEMPRE en español, de forma breve, concreta y práctica, apoyándote en esos datos. Si te pregunta algo que no puedas calcular con la información dada, dilo claramente en vez de inventar cifras. No dés nunca asesoramiento fiscal o legal como si fuera definitivo — cuando sea relevante, recuérdale que lo confirme con su gestoría antes de actuar.`;

export async function preguntarAsistenteFinanciero(pregunta, contexto, historial) {
  const { gemini_api_key } = getConfig();
  if (!gemini_api_key) throw new Error("Falta la clave de Gemini — añádela en Configuración.");
  if (!pregunta || !pregunta.trim()) throw new Error("Escribe una pregunta.");

  const contents = [
    { role: "user", parts: [{ text: `${INSTRUCCION_ASISTENTE}\n\nDATOS FINANCIEROS ACTUALES (JSON):\n${JSON.stringify(contexto)}` }] },
    { role: "model", parts: [{ text: "Entendido, tengo tus datos financieros a mano. ¿En qué puedo ayudarte?" }] },
    ...(historial || []).filter(m => !m.pensando && !m.error).map(m => ({ role: m.rol === "usuario" ? "user" : "model", parts: [{ text: m.texto }] })),
    { role: "user", parts: [{ text: pregunta.trim() }] },
  ];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${encodeURIComponent(gemini_api_key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, generationConfig: { temperature: 0.3, maxOutputTokens: 600 } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Error ${res.status} llamando a Gemini`;
    throw new Error(msg);
  }
  const texto = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
  if (!texto) throw new Error("Gemini no ha devuelto respuesta.");
  return texto;
}
