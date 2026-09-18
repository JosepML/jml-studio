import assert from "node:assert/strict";
import { dividirImporteEnDos, nombresFraccionados, estaFraccionado } from "../js/utils/fraccionamiento.js";

assert.deepEqual(dividirImporteEnDos(1100), [550, 550]);
assert.deepEqual(dividirImporteEnDos(99.99), [50, 49.99]);
assert.deepEqual(nombresFraccionados("Promotora Arquitectura IA"), [
  "Promotora Arquitectura IA 50% 1/2",
  "Promotora Arquitectura IA 50% 2/2",
]);
assert.deepEqual(nombresFraccionados("Trabajo 50% 1/2"), ["Trabajo 50% 1/2", "Trabajo 50% 2/2"]);
assert.equal(estaFraccionado({ fraccion_numero: 1, fraccion_total: 2 }), true);
assert.equal(estaFraccionado({ fraccion_numero: null, fraccion_total: null }), false);

console.log("Fraccionamiento OK: importes, nombres y estado comprobados.");
