import assert from "node:assert/strict";
import { dividirImporte, dividirImporteEnDos, nombresFraccionados, estaFraccionado, normalizarPorcentajes, porcentajesIguales } from "../js/utils/fraccionamiento.js";

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

console.log("Fraccionamiento OK: importes, nombres y estado comprobados.");
