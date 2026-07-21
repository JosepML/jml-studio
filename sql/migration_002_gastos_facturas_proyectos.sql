-- JML Studio — migración 002
-- Añade: relación muchos-a-muchos factura↔proyectos, forma de pago en proyectos,
-- y categorías fiscales + amortización en gastos.
-- Ejecuta esto entero en: Supabase → tu proyecto → SQL Editor → New query → Run

-- ============ PROYECTOS: forma de pago ============
alter table proyectos add column if not exists forma_pago text not null default 'transferencia'
  check (forma_pago in ('transferencia','efectivo','mixto'));

-- ============ FACTURA_PROYECTOS: una factura puede pagar varios proyectos ============
create table if not exists factura_proyectos (
  id uuid primary key default gen_random_uuid(),
  factura_id uuid not null references facturas(id) on delete cascade,
  proyecto_id uuid not null references proyectos(id) on delete cascade,
  importe numeric(10,2) not null default 0,
  created_at timestamptz not null default now(),
  unique (factura_id, proyecto_id)
);

create index if not exists idx_factura_proyectos_factura on factura_proyectos(factura_id);
create index if not exists idx_factura_proyectos_proyecto on factura_proyectos(proyecto_id);

alter table factura_proyectos enable row level security;

drop policy if exists "factura_proyectos_owner" on factura_proyectos;
create policy "factura_proyectos_owner" on factura_proyectos for all
  using (exists (select 1 from facturas f where f.id = factura_id and f.user_id = auth.uid()))
  with check (exists (select 1 from facturas f where f.id = factura_id and f.user_id = auth.uid()));

-- ============ GASTOS: categoría fiscal, IVA parcial, amortización ============
alter table gastos add column if not exists categoria text not null default 'otros'
  check (categoria in ('combustible','material_amortizable','material_fungible','servicios','dietas','fijo','otros'));
alter table gastos add column if not exists iva_soportado numeric(10,2) not null default 0;
alter table gastos add column if not exists iva_deducible_pct numeric(5,2) not null default 100;
alter table gastos add column if not exists es_amortizable boolean not null default false;
alter table gastos add column if not exists tipo_bien text
  check (tipo_bien in ('equipo_audiovisual_informatico','mobiliario','otros_amortizables') or tipo_bien is null);
alter table gastos add column if not exists meses_amortizacion integer;
alter table gastos add column if not exists fecha_inicio_amortizacion date;

-- Fin migración 002.
