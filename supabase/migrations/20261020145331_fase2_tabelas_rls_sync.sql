-- Caderneta do Carro: tabelas sincronizadas com o IndexedDB do app.
-- Regras: cada linha pertence a um usuário (user_id = auth.uid()); o id é gerado no celular;
-- vence a alteração mais recente (updated_at do cliente); server_updated_at é o relógio do servidor usado no pull.

create table public.vehicles (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  make text,
  model text,
  year int check (year between 1900 and 2100),
  engine text,
  fuel_type text not null default 'flex' check (fuel_type in ('flex','gasolina','etanol','diesel')),
  initial_km int check (initial_km >= 0),
  plan_key text,
  archived boolean not null default false,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now()
);

create table public.fuel_logs (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  date date not null,
  odometer_km int not null check (odometer_km >= 0),
  liters numeric(8,3) not null check (liters > 0),
  total_brl numeric(10,2) not null check (total_brl >= 0),
  price_per_l numeric(8,3) not null check (price_per_l >= 0),
  fuel text not null check (fuel in ('gasolina','etanol','diesel','gnv')),
  full_tank boolean not null default true,
  range_left_km int,
  station text,
  note text,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now()
);

create table public.services (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  date date not null,
  odometer_km int check (odometer_km >= 0),
  shop text,
  os_number text,
  type text not null default 'revisao' check (type in ('revisao','corretiva','pneus','outros')),
  note text,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now()
);

create table public.service_items (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  service_id uuid not null references public.services(id) on delete cascade,
  description text not null,
  plan_item_key text,
  parts_brl numeric(10,2) not null default 0 check (parts_brl >= 0),
  labor_brl numeric(10,2) not null default 0 check (labor_brl >= 0),
  next_due_km int,
  next_due_date date,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now()
);

-- Índices para o pull incremental e para as FKs
create index vehicles_user_sync_idx on public.vehicles (user_id, server_updated_at);
create index fuel_logs_user_sync_idx on public.fuel_logs (user_id, server_updated_at);
create index fuel_logs_vehicle_idx on public.fuel_logs (vehicle_id);
create index services_user_sync_idx on public.services (user_id, server_updated_at);
create index services_vehicle_idx on public.services (vehicle_id);
create index service_items_user_sync_idx on public.service_items (user_id, server_updated_at);
create index service_items_service_idx on public.service_items (service_id);

-- Trigger de sincronização:
-- * INSERT: carimba server_updated_at; user_id sempre do usuário logado.
-- * UPDATE: dono não muda; se o updated_at recebido não for mais novo que o gravado, ignora a escrita (vence a mais recente).
create or replace function public.sync_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.user_id := auth.uid();
    end if;
  else
    new.user_id := old.user_id;
    if new.updated_at <= old.updated_at then
      return null;
    end if;
  end if;
  new.server_updated_at := now();
  return new;
end;
$$;

create trigger vehicles_sync_guard before insert or update on public.vehicles for each row execute function public.sync_guard();
create trigger fuel_logs_sync_guard before insert or update on public.fuel_logs for each row execute function public.sync_guard();
create trigger services_sync_guard before insert or update on public.services for each row execute function public.sync_guard();
create trigger service_items_sync_guard before insert or update on public.service_items for each row execute function public.sync_guard();

-- Filhos só podem apontar para pais do mesmo usuário (a FK sozinha não olha a RLS)
create or replace function public.check_parent_owner()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  owner uuid;
begin
  if tg_table_name in ('fuel_logs','services') then
    select v.user_id into owner from public.vehicles v where v.id = new.vehicle_id;
  else
    select s.user_id into owner from public.services s where s.id = new.service_id;
  end if;
  if owner is null or owner <> new.user_id then
    raise exception 'registro pai não encontrado para este usuário' using errcode = '23503';
  end if;
  return new;
end;
$$;

create trigger fuel_logs_parent_owner after insert or update on public.fuel_logs for each row execute function public.check_parent_owner();
create trigger services_parent_owner after insert or update on public.services for each row execute function public.check_parent_owner();
create trigger service_items_parent_owner after insert or update on public.service_items for each row execute function public.check_parent_owner();

-- RLS: cada usuário só enxerga e altera as próprias linhas. Sem DELETE físico pelo app (exclusão é deleted_at).
alter table public.vehicles enable row level security;
alter table public.fuel_logs enable row level security;
alter table public.services enable row level security;
alter table public.service_items enable row level security;

create policy "dono lê" on public.vehicles for select to authenticated using (user_id = (select auth.uid()));
create policy "dono insere" on public.vehicles for insert to authenticated with check (user_id = (select auth.uid()));
create policy "dono altera" on public.vehicles for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "dono lê" on public.fuel_logs for select to authenticated using (user_id = (select auth.uid()));
create policy "dono insere" on public.fuel_logs for insert to authenticated with check (user_id = (select auth.uid()));
create policy "dono altera" on public.fuel_logs for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "dono lê" on public.services for select to authenticated using (user_id = (select auth.uid()));
create policy "dono insere" on public.services for insert to authenticated with check (user_id = (select auth.uid()));
create policy "dono altera" on public.services for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "dono lê" on public.service_items for select to authenticated using (user_id = (select auth.uid()));
create policy "dono insere" on public.service_items for insert to authenticated with check (user_id = (select auth.uid()));
create policy "dono altera" on public.service_items for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Anônimo não acessa nada
revoke all on public.vehicles, public.fuel_logs, public.services, public.service_items from anon;
grant select, insert, update on public.vehicles, public.fuel_logs, public.services, public.service_items to authenticated;
revoke delete on public.vehicles, public.fuel_logs, public.services, public.service_items from authenticated;
