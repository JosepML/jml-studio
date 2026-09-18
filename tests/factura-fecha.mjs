import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const source = await readFile(new URL('../js/views/mensual.js', import.meta.url), 'utf8');

assert.match(source, /fecha:\s*todayIso\(\)/, 'Las facturas nuevas deben usar la fecha actual');
assert.doesNotMatch(
  source,
  /fecha:\s*p\?\.fecha_entrega\s*\|\|\s*p\?\.fecha_inicio\s*\|\|\s*todayIso\(\)/,
  'La fecha no debe heredarse del primer proyecto seleccionado'
);

console.log('OK: la fecha de una factura agrupada es la fecha de creación');
