-- A cota só aceita as funções conhecidas (um usuário não consegue criar linhas à toa chamando a RPC direto)
alter table public.api_usage drop constraint api_usage_fn_check;
alter table public.api_usage add constraint api_usage_fn_check check (fn in ('google_nearby', 'google_posto', 'google_address', 'parse_os'));
