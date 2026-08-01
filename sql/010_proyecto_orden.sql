-- Orden manual de los proyectos dentro de cada mes en Facturación mensual.
--
-- Antes las filas salían ordenadas alfabéticamente por el nombre del proyecto,
-- que no tiene nada que ver con el orden en que a Josep le interesa verlas
-- (por ejemplo, agrupadas por cliente o por el orden en que las va a facturar).
-- Con esta columna el orden lo decide él arrastrando las filas.
--
-- Se deja NULL para los proyectos ya existentes: mientras nadie los ordene a
-- mano se siguen mostrando como siempre, al final y por nombre.
alter table proyectos add column if not exists orden int;

comment on column proyectos.orden is
  'Posición manual dentro de su mes en Facturación mensual. NULL = sin ordenar.';
