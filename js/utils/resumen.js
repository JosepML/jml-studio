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

/**
 * Lo que el cliente paga de verdad, según cómo cobre ese proyecto.
 *
 * En efectivo no se repercute IVA: no hay factura y no entra en el Modelo 303,
 * así que su "importe con IVA" es su propia base. Aplicarle el 21% a todo
 * inflaba los cobros en efectivo en "Pendiente de cobro" y en Proyectos.
 */
export function conIvaSegunPago(base, formaPago, ivaPct = IVA_PCT_DEFECTO) {
  return (formaPago || "transferencia") === "transferencia"
    ? conIva(base, ivaPct)
    : round2(Number(base || 0));
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
  // Se excluyen los BORRADORES: una factura a medio preparar no está emitida,
  // así que su retención todavía no existe.
  const facturasQ = (facturas || []).filter(f =>
    f.tipo === "factura" && f.estado !== "borrador" && enRango(f.fecha, desde, hasta)
  );
  const retenciones = round2(facturasQ.reduce((s, f) => s + Number(f.retencion_importe || 0), 0));
  return { ...base, desde, hasta, retenciones, q };
}

// Resumen trimestral de IVA (Modelo 303).
//
// La base repercutida sale de los PROYECTOS (el ledger), no de la tabla
// `facturas`. Es una decisión de Josep y además es lo correcto: en servicios el
// IVA se devenga cuando se presta el servicio (art. 75 LIVA), no cuando se
// emite la factura. Contando por factura se quedaban fuera los proyectos ya
// entregados que todavía no tienen factura asignada o que se acumularán en una
// factura conjunta más adelante, y encima el resultado bailaba según si una
// factura estaba en borrador o emitida.
//
// IMPORTANTE: solo cuenta la TRANSFERENCIA. Los proyectos cobrados en efectivo
// no pasan por el balance fiscal, así que incluirlos descuadraría el 303.
//
// `baseSinFacturar` avisa de cuánto de esa base todavía no tiene una factura
// emitida detrás: es lo que hay que facturar antes de presentar el trimestre.
export function resumenIvaTrimestre(ledger, facturas, gastos, anio, q, ivaPct = IVA_PCT_DEFECTO) {
  const { desde, hasta } = rangoTrimestre(anio, q);
  const filas = filasEnRango(ledger, desde, hasta).filter(f => f.formaPago === "transferencia");

  const baseRepercutida = round2(filas.reduce((s, f) => s + f.importeBase, 0));
  const ivaRepercutido = round2(baseRepercutida * ivaPct / 100);

  // Trabajo ya entregado que aún no está respaldado por una factura emitida
  // (sin factura, o con una en borrador).
  const baseSinFacturar = round2(filas
    .filter(f => !f.tieneFacturaReal || f.facturaEstado === "borrador")
    .reduce((s, f) => s + f.importeBase, 0));

  const gastosQ = (gastos || []).filter(g => g.deducible !== false && g.con_factura !== false && enRango(g.fecha, desde, hasta));
  const ivaSoportado = round2(gastosQ.reduce((s, g) => {
    const iva = Number(g.iva_soportado || 0);
    const pct = Number(g.iva_deducible_pct ?? 100);
    return s + round2(iva * (pct / 100));
  }, 0));

  // Positivo = a ingresar en Hacienda; negativo = a compensar en el próximo
  // trimestre (o a devolver, si es el último del año).
  const resultado = round2(ivaRepercutido - ivaSoportado);
  return { desde, hasta, q, baseRepercutida, ivaRepercutido, ivaSoportado, resultado, baseSinFacturar };
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
