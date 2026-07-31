-- Migration 003
-- 1) proyectos.estado_facturacion: permite marcar un proyecto como
--    emitida/pagada desde el dashboard mensual aunque todavía no tenga una
--    factura formal generada (antes los checkboxes quedaban deshabilitados
--    para la mayoría de proyectos, que es lo que reportó Josep como "no
--    funcionan"). Si el proyecto SÍ tiene una factura real vinculada, esa
--    factura manda sobre este campo (se ignora).
-- 2) gastos.deducible: permite registrar gastos que afectan al balance real
--    (p. ej. pagos en efectivo sin ticket) pero que NO cuentan de cara a
--    Hacienda, para poder separar el balance fiscal del balance personal.

alter table proyectos add column if not exists estado_facturacion text not null default 'pendiente'
  check (estado_facturacion in ('pendiente','emitida','pagada'));

alter table gastos add column if not exists deducible boolean not null default true;

-- Los proyectos ya marcados como "cobrado" en su kanban se consideran pagados
-- también a efectos de facturación mensual.
update proyectos set estado_facturacion = 'pagada' where estado = 'cobrado' and estado_facturacion = 'pendiente';
