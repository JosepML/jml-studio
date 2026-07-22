// Fuente única de verdad para todos los totales de negocio (Dashboard,
// Facturación mensual, Financiero). Antes cada vista calculaba sus propios
// totales a partir de tablas distintas (facturas reales vs. proyectos) y los
// números no coincidían entre pantallas. Ahora todas construyen el mismo
// "libro mayor" (ledger) a partir de los proyectos —incluyendo los que aún no
// tienen una factura formal generada— y lo resumen con las mismas funciones.
//
// Reglas de negocio (acordadas con Josep):
// - Un proyecto cuenta como ingreso en la fecha de entrega (o inicio si no hay
//   entrega), salvo que ya tenga una factura real vinculada, en cuyo caso se
//   usa la fecha de esa factura.
// - "Transferencia" = ingreso facturable/declarable a Hacienda. "Efectivo" (o
//   "mixto") = ingreso real pero no pasa por el balance fiscal.
// - El estado emitida/pagada de cada fila se lee de la factura real si existe;
//   si no, del campo proyectos.estado_facturacion (para poder marcarlo aunque
//   no se haya generado ningún documento de factura todavía).
// - Un gasto es "deducible" (cuenta para Hacienda) salvo que se marque
//   explícitamente como no deducible (p. ej. pagos en efectivo sin ticket).

import { round2, sumaGastosDeduciblesEnRango } from "./invoice-calc.js";

export const IVA_PCT_DEFECTO = 21;

export function conIva(base, ivaPct = IVA_PCT_DEFECTO) {
  return round2(Number(base || 0) * (1 + ivaPct / 100));
}

// --- Rangos de fechas ---
export function rangoMes(anio, mesIdx) {
  const desde = `${anio}-${String(mesIdx + 1).padStart(2, "0")}-01`;
  const ultimoDia = new Date(anio, mesIdx + 1, 0).getDate();
  const hasta = `${anio}-${String(mesIdx + 1).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;
  return { desde, hasta };
}
export function rangoTrimestre(anio, q) {
  const mesInicio = (q - 1) * 3;
  const { desde } = rangoMes(anio, mesInicio);
  const { hasta } = rangoMes(anio, mesInicio + 2);
  return { desde, hasta };
}
export function rangoAnio(anio) {
  return { desde: `${anio}-01-01`, hasta: `${anio}-12-31` };
}

// proyectos: filas de `proyectos`.
// facturaProyectos: filas de `factura_proyectos` con join
//   "importe,factura_id,proyecto_id,facturas(numero,estado,fecha,tipo)"
export function construirLedger(proyectos, facturaProyectos) {
  const fpPorProyecto = {};
  (facturaProyectos || []).forEach(fp => {
    if (!fp.facturas || fp.facturas.tipo !== "factura") return;
    (fpPorProyecto[fp.proyecto_id] ||= []).push(fp);
  });

  const filas = [];
  (proyectos || []).forEach(p => {
    const vinculos = fpPorProyecto[p.id];
    const fechaRef = p.fecha_entrega || p.fecha_inicio || null;
    const formaPago = p.forma_pago || "transferencia";
    if (vinculos && vinculos.length) {
      vinculos.forEach(v => {
        filas.push({
          proyecto: p,
          fecha: v.facturas.fecha || fechaRef,
          importeBase: round2(Number(v.importe || 0)),
          formaPago,
          facturaNumero: v.facturas.numero,
          facturaEstado: v.facturas.estado, // borrador|emitida|pagada|vencida
          facturaId: v.factura_id,
          tieneFacturaReal: true,
        });
      });
    } else {
      filas.push({
        proyecto: p,
        fecha: fechaRef,
        importeBase: round2(Number(p.precio_acordado || 0)),
        formaPago,
        facturaNumero: null,
        facturaEstado: p.estado_facturacion || "pendiente", // pendiente|emitida|pagada
        facturaId: null,
        tieneFacturaReal: false,
      });
    }
  });
  return filas;
}

function enRango(fecha, desde, hasta) {
  return !!fecha && fecha >= desde && fecha <= hasta;
}

export function filasEnRango(ledger, desde, hasta) {
  return (ledger || []).filter(f => enRango(f.fecha, desde, hasta));
}

// Resumen de ingresos (del ledger, ya filtrado o no) + gastos deducibles/no
// deducibles para un rango de fechas [desde, hasta] (strings ISO, inclusive).
export function resumenPeriodo(ledger, gastos, desde, hasta) {
  const filas = filasEnRango(ledger, desde, hasta);
  const transferencia = round2(filas.filter(f => f.formaPago === "transferencia").reduce((s, f) => s + f.importeBase, 0));
  const efectivo = round2(filas.filter(f => f.formaPago !== "transferencia").reduce((s, f) => s + f.importeBase, 0));
  const totalBase = round2(transferencia + efectivo);

  // Solo lo marcado como "pagada" en las casillas de Facturación mensual —
  // usado por Financiero, que debe contar cobros reales, no lo simplemente
  // facturado/emitido.
  const pagadas = filas.filter(f => estadoEfectivo(f) === "pagada");
  const transferenciaPagada = round2(pagadas.filter(f => f.formaPago === "transferencia").reduce((s, f) => s + f.importeBase, 0));
  const efectivoPagada = round2(pagadas.filter(f => f.formaPago !== "transferencia").reduce((s, f) => s + f.importeBase, 0));
  const transferenciaNoPagada = round2(transferencia - transferenciaPagada);
  const efectivoNoPagada = round2(efectivo - efectivoPagada);
  const noPagado = round2(transferenciaNoPagada + efectivoNoPagada);

  const gastosLista = gastos || [];
  const deducibles = gastosLista.filter(g => g.deducible !== false);
  const noDeducibles = gastosLista.filter(g => g.deducible === false);

  const gastosDeducibles = round2(sumaGastosDeduciblesEnRango(deducibles, desde, hasta));
  const gastosNoDeducibles = round2(noDeducibles
    .filter(g => enRango(g.fecha, desde, hasta))
    .reduce((s, g) => s + Number(g.importe || 0), 0));

  return {
    filas,
    transferencia, efectivo, totalBase,
    transferenciaPagada, efectivoPagada, transferenciaNoPagada, efectivoNoPagada, noPagado,
    totalConIva: conIva(totalBase),
    gastosDeducibles, gastosNoDeducibles,
    gastosTotales: round2(gastosDeducibles + gastosNoDeducibles),
    beneficioFiscal: round2(transferencia - gastosDeducibles),
    beneficioFiscalPagado: round2(transferenciaPagada - gastosDeducibles),
    beneficioReal: round2(totalBase - gastosDeducibles - gastosNoDeducibles),
    beneficioRealPagado: round2(transferenciaPagada + efectivoPagada - gastosDeducibles - gastosNoDeducibles),
  };
}

// Resumen trimestral con retenciones (para Modelo 130) — las retenciones solo
// existen en facturas reales, por lo que se leen de la tabla `facturas`.
export function resumenTrimestre(ledger, facturas, gastos, anio, q) {
  const { desde, hasta } = rangoTrimestre(anio, q);
  const base = resumenPeriodo(ledger, gastos, desde, hasta);
  const facturasQ = (facturas || []).filter(f => f.tipo === "factura" && enRango(f.fecha, desde, hasta));
  const retenciones = round2(facturasQ.reduce((s, f) => s + Number(f.retencion_importe || 0), 0));
  return { ...base, desde, hasta, retenciones, q };
}

export function estadoEfectivo(fila) {
  // Normaliza el estado a un vocabulario común independientemente de si es
  // una factura real (borrador/emitida/pagada/vencida) o un estado manual de
  // proyecto (pendiente/emitida/pagada).
  const e = fila.facturaEstado;
  if (e === "pagada") return "pagada";
  if (e === "emitida" || e === "vencida") return "emitida";
  return "pendiente";
}
