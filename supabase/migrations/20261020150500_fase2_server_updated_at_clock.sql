-- server_updated_at distinto por linha (clock_timestamp), para a paginação do pull não perder linhas gravadas no mesmo lote
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
  new.server_updated_at := clock_timestamp();
  return new;
end;
$$;
