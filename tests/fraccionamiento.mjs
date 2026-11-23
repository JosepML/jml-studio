import assert from "node:assert/strict";
import { dividirImporte, dividirImporteEnDos, nombresFraccionados, estaFraccionado, normalizarPorcentajes, porcentajesIguales, resolverReparto } from "../js/utils/fraccionamiento.js";

assert.deepEqual(dividirImporteEnDos(1100), [550, 550]);
assert.deepEqual(dividirImporteEnDos(99.99), [50, 49.99]);
assert.deepEqual(normalizarPorcentajes([50, 30, 20]), [50, 30, 20]);
assert.equal(normalizarPorcentajes([50, 30, 10]), null);
assert.deepEqual(dividirImporte(1000, [50, 30, 20]), [500, 300, 200]);
assert.deepEqual(dividirImporte(99.99, [33.33, 33.33, 33.34]), [33.33, 33.33, 33.33]);
assert.deepEqual(porcentajesIguales(3), [33.33, 33.33, 33.34]);
assert.deepEqual(nombresFraccionados("Promotora Arquitectura IA"), [
  "Promotora Arquitectura IA 50% 1/2",
  "Promotora Arquitectura IA 50% 2/2",
]);
assert.deepEqual(nombresFraccionados("Trabajo 50% 1/2"), ["Trabajo 50% 1/2", "Trabajo 50% 2/2"]);
assert.equal(estaFraccionado({ fraccion_numero: 1, fraccion_total: 2 }), true);
assert.equal(estaFraccionado({ fraccion_numero: null, fraccion_total: null }), false);

// Reparto por importe: 800 + 902 sobre 1.702 € (caso ForecourtTech).
let r = resolverReparto(1702, [{ modo: "eur", valor: 800 }, { modo: "eur", valor: 902 }]);
assert.equal(r.valido, true);
assert.deepEqual(r.importes, [800, 902]);
assert.equal(r.porcentajes.reduce((s, v) => s + v, 0).toFixed(2), "100.00");
// Un importe y el resto en porcentaje.
r = resolverReparto(1702, [{ modo: "eur", valor: 800 }, { modo: "pct", valor: 52.94 }]);
assert.equal(r.valido, false); // 52,94 % = 901,04 \u20ac, faltan 0,96 \u20ac
assert.equal(r.diferencia, 0.96);
// Suma que no cuadra: avisa de la diferencia.
r = resolverReparto(1000, [{ modo: "eur", valor: 400 }, { modo: "eur", valor: 500 }]);
assert.equal(r.valido, false);
assert.equal(r.diferencia, 100);
// Coma flotante: 0,1 + 0,2 = 0,3.
assert.equal(resolverReparto(0.3, [{ modo: "eur", valor: 0.1 }, { modo: "eur", valor: 0.2 }]).valido, true);
// Solo porcentajes: conserva el comportamiento anterior.
r = resolverReparto(99.99, [{ modo: "pct", valor: 33.33 }, { modo: "pct", valor: 33.33 }, { modo: "pct", valor: 33.34 }]);
assert.equal(r.valido, true);
assert.deepEqual(r.importes, [33.33, 33.33, 33.33]);

console.log("Fraccionamiento OK: importes, nombres y estado comprobados.");
