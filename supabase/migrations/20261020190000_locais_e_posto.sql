-- Casa, trabalho e o caminho entre eles (base para a aba Postos), um registro por tipo e usuário.
-- Guardamos rua/bairro e o ponto no mapa; o número da casa não é gravado.
create table public.user_places (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('casa', 'trabalho', 'rota')),
  label text check (char_length(label) <= 120),
  lat double precision check (lat between -90 and 90),
  lon double precision check (lon between -180 and 180),
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 60000),
  updated_at timestamptz not null,
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now(),
  primary key (user_id, kind)
);

create trigger user_places_sync_guard before insert or update on public.user_places
  for each row execute function public.sync_guard();

alter table public.user_places enable row level security;
create policy "dono lê" on public.user_places for select to authenticated using (user_id = (select auth.uid()));
create policy "dono insere" on public.user_places for insert to authenticated with check (user_id = (select auth.uid()));
create policy "dono altera" on public.user_places for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.user_places from anon;
grant select, insert, update on public.user_places to authenticated;
revoke delete on public.user_places from authenticated;

-- Posto do abastecimento (CNPJ do cadastro da ANP), quando escolhido pela aba Postos
alter table public.fuel_logs add column station_id text check (station_id ~ '^\d{14}$');
