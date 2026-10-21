-- Fotos dos postos (Google Places Photos) também contam na cota diária por usuário
alter table public.api_usage drop constraint api_usage_fn_check;
alter table public.api_usage add constraint api_usage_fn_check check (fn in ('google_nearby', 'google_posto', 'google_address', 'google_photo', 'parse_os'));
