-- Historial de conversaciones del chat financiero.
-- Ya aplicado en el proyecto Supabase de JML Studio.

create table if not exists public.chat_conversaciones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  titulo text not null default 'Nueva conversación',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.chat_mensajes (
  id uuid primary key default gen_random_uuid(),
  conversacion_id uuid not null references public.chat_conversaciones(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  rol text not null check (rol in ('usuario', 'ia')),
  contenido text not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_conversaciones_user_updated_idx
  on public.chat_conversaciones(user_id, updated_at desc);
create index if not exists chat_mensajes_conversacion_created_idx
  on public.chat_mensajes(conversacion_id, created_at);

alter table public.chat_conversaciones enable row level security;
alter table public.chat_mensajes enable row level security;

create policy "chat_conversaciones_owner" on public.chat_conversaciones
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "chat_mensajes_owner" on public.chat_mensajes
  for all to authenticated
  using (exists (
    select 1 from public.chat_conversaciones c
    where c.id = conversacion_id and c.user_id = (select auth.uid())
  ))
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.chat_conversaciones c
      where c.id = conversacion_id and c.user_id = (select auth.uid())
    )
  );

grant select, insert, update, delete on public.chat_conversaciones to authenticated;
grant select, insert, update, delete on public.chat_mensajes to authenticated;
