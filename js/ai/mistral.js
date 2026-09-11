// IA de la app: OpenRouter, llamada directa desde el navegador.
//
// Se usa el router gratuito de OpenRouter para que pueda cambiar de modelo
// disponible sin tocar la aplicación. El router tiene límites diarios, pero
// no requiere saldo ni tarjeta para las peticiones gratuitas.
//
// Su API es compatible con OpenAI y acepta peticiones desde el navegador, así
// que no hace falta servidor. La clave vive solo en localStorage.
import { getConfig } from "../utils/config-usuario.js";

const URL_API = "https://openrouter.ai/api/v1/chat/completions";
const MODELO = "openrouter/free";
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
    return new Error("La clave de OpenRouter no es válida o ha caducado. Crea una nueva en Configuración → IA y pulsa «Probar».");
  }
  if (res.status === 402) {
    return new Error("OpenRouter ha rechazado la petición por saldo o límites. Comprueba que estás usando una clave de OpenRouter gratuita.");
  }
  if (res.status === 403) {
    return new Error("Esta clave no tiene permiso para usar modelos gratuitos. Crea una clave nueva en OpenRouter y guárdala en Configuración → IA.");
  }
  if (res.status === 404) {
    return new Error("El router gratuito no está disponible temporalmente. Espera unos minutos y vuelve a probar.");
  }
  if (res.status >= 500) {
    return new Error("El servicio gratuito de IA está teniendo un problema temporal. Espera un momento y vuelve a intentarlo.");
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
          "HTTP-Referer": window.location.origin,
          "X-Title": "JML Studio",
        },
        body: JSON.stringify({
          model: MODELO,
          messages: mensajes,
          temperature,
          max_tokens: maxTokens,
          // Algunos modelos gratuitos del router gastan todo el límite en
          // razonamiento y dejan `message.content` vacío. Para esta app
          // necesitamos texto final directamente, no el razonamiento interno.
          reasoning: { effort: "none", exclude: true },
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
      const contenido = data?.choices?.[0]?.message?.content;
      const texto = (Array.isArray(contenido)
        ? contenido.map(parte => typeof parte === "string" ? parte : parte?.text || "").join("")
        : contenido || "").trim();
      if (!texto) throw new Error("La IA no ha devuelto ninguna respuesta.");
      return texto;
    }

    // El modo gratuito limita las ráfagas. Reintentamos dos veces de forma
    // transparente, respetando Retry-After cuando el servicio lo proporciona.
    if (res.status === 429 && intento < REINTENTOS_MAXIMOS) {
      const esperaIndicada = Number(res.headers.get("Retry-After"));
      const espera = Number.isFinite(esperaIndicada) && esperaIndicada > 0
        ? Math.min(esperaIndicada * 1000, 8000)
        : (intento + 1) * 1500;
      await pausa(espera);
      continue;
    }

    if (res.status === 429) throw new Error("Se ha alcanzado el límite gratuito de OpenRouter. Espera un poco o vuelve a probar mañana.");
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

/* ---------------------------------------------- lectura de justificantes */

function extraerJson(texto) {
  const limpio = String(texto || "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(limpio); } catch { /* el modelo puede añadir una frase */ }
  const inicio = limpio.indexOf("{");
  const fin = limpio.lastIndexOf("}");
  if (inicio !== -1 && fin > inicio) {
    try { return JSON.parse(limpio.slice(inicio, fin + 1)); } catch { /* se informa abajo */ }
  }
  throw new Error("La IA no ha devuelto los datos en un formato válido. Puedes rellenar el gasto manualmente.");
}

// Lee una imagen de ticket/factura o el texto extraído localmente de un PDF.
// No guarda el archivo ni confía en la IA para hacer cálculos fiscales: solo
// devuelve una propuesta que el formulario de Gastos debe revisar.
export async function extraerGastoDesdeJustificante({ imagenes = [], texto = "", nombre = "justificante" } = {}) {
  if (!imagenes.length && !texto.trim()) throw new Error("No se ha encontrado contenido legible en el justificante.");
  const contenido = [{
    type: "text",
    text: `Analiza este justificante de gasto (${nombre}). Devuelve SOLO un JSON válido, sin markdown ni comentarios, con exactamente estas claves: proveedor, nif, numero_documento, fecha (YYYY-MM-DD o null), concepto, base_imponible, iva_porcentaje, iva_soportado, total, categoria, confianza, advertencias. Los importes deben ser números sin símbolo de moneda o null si no aparecen. categoria debe ser una de: software, material_amortizable, combustible, transporte, dietas, suministros, servicios_profesionales, seguros, formacion, otros. confianza debe ser un número entre 0 y 1. No inventes valores: usa null cuando no se vean. Si es un ticket sin número de factura, deja numero_documento en null. Comprueba visualmente los datos, pero no inventes ni corrijas importes que no figuren en el documento.${texto.trim() ? `\n\nTEXTO EXTRAÍDO DEL PDF:\n${texto.trim().slice(0, 12000)}` : ""}`,
  }];
  imagenes.slice(0, 6).forEach(url => contenido.push({ type: "image_url", image_url: { url } }));
  const respuesta = await chat([{ role: "user", content: contenido }], { temperature: 0.1, maxTokens: 900 });
  const datos = extraerJson(respuesta);
  const numero = valor => {
    if (valor === null || valor === undefined || valor === "") return null;
    if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
    const limpio = String(valor).replace(/[^\d,.-]/g, "");
    const normalizado = limpio.includes(",") ? limpio.replace(/\./g, "").replace(",", ".") : limpio;
    const resultado = Number(normalizado);
    return Number.isFinite(resultado) ? resultado : null;
  };
  return {
    proveedor: datos.proveedor ?? null,
    nif: datos.nif ?? null,
    numero_documento: datos.numero_documento ?? null,
    fecha: datos.fecha ?? null,
    concepto: datos.concepto ?? null,
    base_imponible: numero(datos.base_imponible),
    iva_porcentaje: numero(datos.iva_porcentaje),
    iva_soportado: numero(datos.iva_soportado),
    total: numero(datos.total),
    categoria: datos.categoria || "otros",
    confianza: Math.max(0, Math.min(1, Number(datos.confianza) || 0)),
    advertencias: Array.isArray(datos.advertencias) ? datos.advertencias : (datos.advertencias ? [String(datos.advertencias)] : []),
  };
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
