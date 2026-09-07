import assert from "node:assert/strict";
import fs from "node:fs";

const index = fs.readFileSync("index.html", "utf8");
const app = fs.readFileSync("js/app.js", "utf8");
const sw = fs.readFileSync("sw.js", "utf8");

const rutas = [
  ["dashboard", "js/views/dashboard.js"],
  ["mensual", "js/views/mensual.js"],
  ["proyectos", "js/views/proyectos.js"],
  ["clientes", "js/views/clientes.js"],
  ["facturacion", "js/views/facturacion.js"],
  ["presupuestos", "js/views/facturacion.js"],
  ["gastos", "js/views/gastos.js"],
  ["financiero", "js/views/financiero.js"],
  ["configuracion", "js/views/configuracion.js"],
];

for (const [ruta, archivo] of rutas) {
  assert.ok(fs.existsSync(archivo), `${ruta}: no existe ${archivo}`);
  assert.match(app, new RegExp(`\\b${ruta}\\s*:`), `${ruta}: no está registrada en el router`);
  assert.match(index, new RegExp(`data-route="${ruta}"`), `${ruta}: no está enlazada en el menú`);
}

for (const [, archivo] of rutas) {
  assert.match(sw, new RegExp(archivo.replaceAll("/", "\\/")), `${archivo}: no está en el caché del service worker`);
}

assert.doesNotMatch(app, /alert\s*\(/, "El router no debe usar alertas nativas");
console.log(`Smoke navegación OK: ${rutas.length} rutas comprobadas.`);
