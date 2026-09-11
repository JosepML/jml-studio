import assert from "node:assert/strict";
import fs from "node:fs";

const gastos = fs.readFileSync("js/views/gastos.js", "utf8");
const ia = fs.readFileSync("js/ai/mistral.js", "utf8");
const documentos = fs.readFileSync("js/utils/justificantes.js", "utf8");
const sw = fs.readFileSync("sw.js", "utf8");

assert.match(gastos, /id="btn-importar-justificante"/, "Gastos debe ofrecer importar justificantes");
assert.match(gastos, /accept="image\/\*,application\/pdf"/, "El selector debe aceptar imágenes y PDF");
assert.match(gastos, /aplicarExtraccion/, "La extracción debe pasar por una revisión en el formulario");
assert.match(ia, /extraerGastoDesdeJustificante/, "La IA debe exponer el lector de gastos");
assert.match(ia, /openrouter\/free/, "El lector debe usar exclusivamente el router gratuito");
assert.match(ia, /qwen\/qwen2\.5-vl-32b-instruct:free/, "La lectura debe priorizar un modelo gratuito de visión estable");
assert.match(ia, /json_schema/, "La extracción debe solicitar una respuesta estructurada");
assert.match(ia, /reasoning: \{ effort: "low", exclude: true \}/, "La lectura debe reservar tokens para la respuesta final");
assert.match(documentos, /application\/pdf/, "Debe existir la ruta de lectura de PDF");
assert.match(documentos, /getTextContent/, "Los PDF con texto deben procesarse localmente");
assert.match(documentos, /renderizarPagina/, "Los PDF escaneados deben poder convertirse a imagen");
assert.match(sw, /utils\/justificantes\.js/, "El lector debe estar en el caché de la aplicación");

console.log("Importador de gastos OK: imagen, PDF, revisión y router gratuito comprobados.");
