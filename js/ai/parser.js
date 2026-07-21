// Motor de reglas para el Flujo A del Asistente IA: extraer datos de cliente
// de un texto libre pegado (email, WhatsApp, nota...), sin llamar a ninguna
// API de pago. Cada campo detectado se marca con su origen para que el
// usuario lo confirme antes de guardar. Funciona línea a línea para evitar
// que una expresión regular "coma con todo" a lo largo de varias líneas.

const RE_NIF_CIF = /\b([A-HJ-NP-SUVW][0-9]{7}[0-9A-J]|[0-9]{8}[A-Z])\b/i;
const RE_EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const RE_IBAN = /\bES\d{2}\s?(\d{4}\s?){5}\b/i;
const RE_TELEFONO = /(?:\+34\s?)?\b[679]\d{2}[\s.-]?\d{3}[\s.-]?\d{3}\b/;
const RE_CP = /\b\d{5}\b/;
const RE_FORMA_JURIDICA = /\b(S\.?L\.?U?\.?|S\.?A\.?|SCOOP)\b/i;

export function parseClienteDesdeTexto(texto) {
  const lineas = (texto || "").split("\n").map(l => l.trim()).filter(Boolean);
  const campos = {};
  const usadas = new Set();

  lineas.forEach((linea, i) => {
    if (!campos.nif && RE_NIF_CIF.test(linea)) {
      campos.nif = { valor: linea.match(RE_NIF_CIF)[0].toUpperCase(), origen: "detectado" };
      usadas.add(i);
    }
    if (!campos.email && RE_EMAIL.test(linea)) {
      campos.email = { valor: linea.match(RE_EMAIL)[0], origen: "detectado" };
      usadas.add(i);
    }
    if (!campos.iban && RE_IBAN.test(linea)) {
      campos.iban = { valor: linea.match(RE_IBAN)[0].replace(/\s+/g, " ").trim(), origen: "detectado" };
      usadas.add(i);
    }
    if (!campos.telefono && RE_TELEFONO.test(linea) && !RE_NIF_CIF.test(linea)) {
      campos.telefono = { valor: linea.match(RE_TELEFONO)[0], origen: "detectado" };
      usadas.add(i);
    }
    if (!campos.direccion && RE_CP.test(linea)) {
      campos.direccion = { valor: linea, origen: "detectado" };
      usadas.add(i);
    }
    if (!campos.nombre && RE_FORMA_JURIDICA.test(linea)) {
      campos.nombre = { valor: linea, origen: "detectado" };
      campos.tipo = { valor: "empresa", origen: "detectado" };
      usadas.add(i);
    }
  });

  // Si no hay nombre de empresa, usar la primera línea libre (no clasificada
  // como otro campo) como nombre de particular, para que el usuario confirme.
  if (!campos.nombre) {
    const idx = lineas.findIndex((_, i) => !usadas.has(i) && lineas[i].length < 60);
    if (idx !== -1) {
      campos.nombre = { valor: lineas[idx], origen: "sugerido — revisa" };
      campos.tipo = { valor: "particular", origen: "sugerido — revisa" };
      usadas.add(idx);
    }
  }

  const notaLibre = lineas.filter((_, i) => !usadas.has(i)).join(" ").slice(0, 500);
  if (notaLibre) campos.notas = { valor: notaLibre, origen: "nota libre" };

  return campos;
}
