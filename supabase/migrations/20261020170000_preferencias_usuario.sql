-- Preferências por usuário (indicadores do Início), sincronizadas entre aparelhos
create table public.user_settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  home_indicators jsonb not null default '["gasto_mes","km_mes"]'::jsonb,
  updated_at timestamptz not null,
  server_updated_at timestamptz not null default now()
);

create trigger user_settings_sync_guard before insert or update on public.user_settings
  for each row execute function public.sync_guard();

alter table public.user_settings enable row level security;
create policy "dono lê" on public.user_settings for select to authenticated using (user_id = (select auth.uid()));
create policy "dono insere" on public.user_settings for insert to authenticated with check (user_id = (select auth.uid()));
create policy "dono altera" on public.user_settings for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.user_settings from anon;
grant select, insert, update on public.user_settings to authenticated;
revoke delete on public.user_settings from authenticated;
