-- JML Studio — migración 006
-- Guarda cuándo se marcó como emitido un proyecto sin factura real vinculada.
-- La sección "Margen de facturación" solo descuenta lo emitido a partir de la
-- fecha de corte, y hasta ahora el estado emitida/pagada no llevaba fecha.
-- Los proyectos ya emitidos antes de esta migración quedan en null y no cuentan.

alter table proyectos add column if not exists fecha_emision date;

-- Nueva forma de pago "Alta en S.S." (trabajo facturado para el alta en la
-- Seguridad Social). No cuenta como transferencia en el margen ni en el 303.
alter table proyectos drop constraint if exists proyectos_forma_pago_check;
alter table proyectos add constraint proyectos_forma_pago_check
  check (forma_pago in ('transferencia','efectivo','mixto','alta_ss'));
