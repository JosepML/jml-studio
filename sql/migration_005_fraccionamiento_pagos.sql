-- JML Studio — migración 005
-- Permite representar un pago fraccionado como dos proyectos independientes
-- con el mismo grupo, para que cada mitad tenga su propio cobro y factura.

alter table proyectos add column if not exists fraccion_grupo_id uuid;
alter table proyectos add column if not exists fraccion_numero smallint;
alter table proyectos add column if not exists fraccion_total smallint;

alter table proyectos drop constraint if exists proyectos_fraccion_valida;
alter table proyectos add constraint proyectos_fraccion_valida check (
  (fraccion_grupo_id is null and fraccion_numero is null and fraccion_total is null)
  or (
    fraccion_grupo_id is not null
    and fraccion_numero is not null
    and fraccion_total is not null
    and fraccion_total > 1
    and fraccion_numero between 1 and fraccion_total
  )
);

create index if not exists idx_proyectos_fraccion_grupo on proyectos(fraccion_grupo_id);
