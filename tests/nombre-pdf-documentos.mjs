import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const source = await readFile(new URL('../js/views/facturacion.js', import.meta.url), 'utf8');

assert.match(
  source,
  /const prefijoArchivo\s*=\s*esPresupuesto\s*\?\s*"PRESUPUESTO"\s*:\s*"FACTURA"/,
  'Los documentos deben descargarse con el prefijo en mayúsculas'
);
assert.match(source, /pdf\.save\(`\$\{prefijoArchivo\}-\$\{numero\}/, 'El prefijo debe formar parte del nombre del PDF');

console.log('OK: los PDF de facturas se descargan como FACTURA-numero');
