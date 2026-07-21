-- JML Studio — esquema de base de datos (Supabase / Postgres)
-- Ejecuta esto entero en: Supabase → tu proyecto → SQL Editor → New query → Run

create extension if not exists pgcrypto;

-- ============ CLIENTES ============
create table if not exists clientes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  nombre text not null,
  tipo text not null default 'empresa' check (tipo in ('empresa','particular')),
  nif text,
  email text,
  telefono text,
  direccion text,
  notas text,
  created_at timestamptz not null default now()
);

-- ============ PROYECTOS ============
create table if not exists proyectos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  cliente_id uuid references clientes(id) on delete set null,
  nombre text not null,
  estado text not null default 'presupuestado'
    check (estado in ('presupuestado','en_curso','en_revision','cobrado')),
  fecha_inicio date,
  fecha_entrega date,
  horas_invertidas numeric(10,2) not null default 0,
  coste_asociado numeric(10,2) not null default 0,
  precio_acordado numeric(10,2) not null default 0,
  entregables jsonb not null default '[]',
  notas text,
  created_at timestamptz not null default now()
);

-- ============ FACTURAS Y PRESUPUESTOS ============
create table if not exists facturas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  proyecto_id uuid references proyectos(id) on delete set null,
  cliente_id uuid references clientes(id) on delete set null,
  numero text not null,
  tipo text not null default 'factura' check (tipo in ('presupuesto','factura')),
  fecha date not null default current_date,
  fecha_vencimiento date,
  lineas jsonb not null default '[]',       -- [{concepto, cantidad, precio}]
  base_imponible numeric(10,2) not null default 0,
  iva_pct numeric(5,2) not null default 21,
  iva_importe numeric(10,2) not null default 0,
  retencion_pct numeric(5,2) not null default 0,
  retencion_importe numeric(10,2) not null default 0,
  total numeric(10,2) not null default 0,
  estado text not null default 'borrador'
    check (estado in ('borrador','emitida','pagada','vencida')),
  created_at timestamptz not null default now()
);

-- ============ GASTOS ============
create table if not exists gastos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  proyecto_id uuid references proyectos(id) on delete set null,
  concepto text not null,
  importe numeric(10,2) not null default 0,
  tipo text not null default 'variable' check (tipo in ('fijo','variable')),
  fecha date not null default current_date,
  recurrente boolean not null default false,
  created_at timestamptz not null default now()
);

-- ============ ÍNDICES ============
create index if not exists idx_proyectos_cliente on proyectos(cliente_id);
create index if not exists idx_facturas_proyecto on facturas(proyecto_id);
create index if not exists idx_facturas_cliente on facturas(cliente_id);
create index if not exists idx_gastos_proyecto on gastos(proyecto_id);

-- ============ SEGURIDAD (RLS): cada usuario solo ve sus propios datos ============
alter table clientes enable row level security;
alter table proyectos enable row level security;
alter table facturas enable row level security;
alter table gastos enable row level security;

create policy "clientes_owner" on clientes for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "proyectos_owner" on proyectos for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "facturas_owner" on facturas for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "gastos_owner" on gastos for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Fin. Después de ejecutar esto:
-- 1. Ve a Authentication → Users → Add user (tu email + una contraseña) para crear tu único usuario.
-- 2. Ve a Project Settings → API y copia "Project URL" y la clave "anon public".
-- 3. Pégame esas dos claves para dejar la app conectada.
