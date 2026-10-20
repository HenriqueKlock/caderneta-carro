-- 1) Só as permissões que o app usa. TRUNCATE ignora a RLS; REFERENCES e TRIGGER não servem ao app.
revoke truncate, references, trigger on all tables in schema public from authenticated, anon;
alter default privileges in schema public revoke truncate, references, trigger on tables from authenticated, anon;

-- 2) Cota diária por usuário para as funções que custam dinheiro (Google Places, API do Claude).
create table public.api_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null default current_date,
  fn text not null check (fn ~ '^[a-z0-9_:-]{1,40}$'),
  n integer not null default 0,
  primary key (user_id, day, fn)
);
alter table public.api_usage enable row level security;
revoke all on public.api_usage from anon, authenticated;

-- Conta uma chamada e diz se ainda está dentro do limite. Só mexe na linha do próprio usuário.
create or replace function public.consume_quota(p_fn text, p_max integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  used integer;
begin
  if uid is null then
    return false;
  end if;
  insert into public.api_usage as u (user_id, day, fn, n)
  values (uid, current_date, p_fn, 1)
  on conflict (user_id, day, fn) do update set n = u.n + 1
  returning u.n into used;
  return used <= p_max;
end;
$$;
revoke all on function public.consume_quota(text, integer) from public, anon;
grant execute on function public.consume_quota(text, integer) to authenticated;
