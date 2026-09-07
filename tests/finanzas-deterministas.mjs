import assert from "node:assert/strict";
import { construirLedger, estadoEfectivo, resumenIvaTrimestre } from "../js/utils/resumen.js";
import { calcularModelo130Trimestral } from "../js/utils/invoice-calc.js";

const proyectos = [
  { id: "emitida", cliente_id: "c1", precio_acordado: 100, forma_pago: "transferencia", fecha_entrega: "2026-09-05", estado_facturacion: "pendiente" },
  { id: "efectivo", cliente_id: "c1", precio_acordado: 200, forma_pago: "efectivo", fecha_entrega: "2026-09-06", estado_facturacion: "pagada" },
  { id: "pendiente", cliente_id: "c1", precio_acordado: 900, forma_pago: "transferencia", fecha_entrega: "2026-09-07", estado_facturacion: "pendiente" },
  { id: "futuro", cliente_id: "c1", precio_acordado: 300, forma_pago: "transferencia", fecha_entrega: "2026-10-01", estado_facturacion: "emitida" },
];
const facturaProyectos = [{
  proyecto_id: "emitida", factura_id: "f1", importe: 100,
  facturas: { numero: "12-2026", tipo: "factura", estado: "emitida", fecha: "2026-09-05" },
}];
const ledger = construirLedger(proyectos, facturaProyectos);
const emitido = ledger.filter(f => estadoEfectivo(f) !== "pendiente");

assert.equal(emitido.length, 2, "solo deben entrar emitida y pagada");
assert.deepEqual(emitido.map(f => f.proyecto.id).sort(), ["efectivo", "emitida"]);

const iva = resumenIvaTrimestre(emitido, [], [], 2026, 3);
assert.equal(iva.baseRepercutida, 100, "el efectivo no entra en la base del IVA");
assert.equal(iva.ivaRepercutido, 21, "el IVA repercutido debe ser el 21% de la transferencia");
assert.equal(iva.baseSinFacturar, 0, "un trabajo emitido no se considera sin factura");

const irpf = calcularModelo130Trimestral({ ingresosTrimestre: 1000, gastosTrimestre: 300, pctModelo130: 7 });
assert.equal(irpf.rendimientoNeto, 700, "el beneficio es facturación menos gastos");
assert.equal(irpf.aIngresar, 49, "el IRPF previsto es el 7% del beneficio");

console.log("Finanzas deterministas OK: emitidas, futuros, efectivo, IVA e IRPF.");
