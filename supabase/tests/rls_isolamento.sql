-- Teste de isolamento entre usuários (caixa cinza), rodado direto no banco.
-- Cria dois usuários fictícios (A e B) dentro de uma transação, faz B tentar ler e mexer nos dados de A
-- e um visitante sem login tentar ler tudo. No fim, LEVANTA UM ERRO DE PROPÓSITO com o resultado:
-- isso desfaz tudo (nenhum dado fica no banco). Procure por "FALHOU" na mensagem.
do $$
declare
  a uuid := 'aaaaaaaa-0000-4000-8000-00000000000a';
  b uuid := 'bbbbbbbb-0000-4000-8000-00000000000b';
  va uuid := gen_random_uuid(); fa uuid := gen_random_uuid(); sa uuid := gen_random_uuid(); ia uuid := gen_random_uuid();
  res text[] := '{}';
  n bigint;
  ok_count int := 0;
  fail_count int := 0;
  t text;

begin
  insert into auth.users (id, email, aud, role, instance_id) values
    (a, 'teste-a@exemplo.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
    (b, 'teste-b@exemplo.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

  -- ===== A cria os próprios dados =====
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into public.vehicles (id, name, fuel_type, archived, updated_at) values (va, 'Carro A', 'flex', false, now());
  insert into public.fuel_logs (id, vehicle_id, date, odometer_km, liters, total_brl, price_per_l, fuel, full_tank, updated_at)
    values (fa, va, current_date, 1000, 40, 260, 6.5, 'gasolina', true, now());
  insert into public.services (id, vehicle_id, date, type, updated_at) values (sa, va, current_date, 'revisao', now());
  insert into public.service_items (id, service_id, description, parts_brl, labor_brl, updated_at) values (ia, sa, 'Óleo', 100, 50, now());
  insert into public.user_settings (home_indicators, updated_at) values ('["gasto_mes"]', now());
  insert into public.user_places (kind, label, lat, lon, updated_at) values ('casa', 'Rua de A', -27.6, -48.5, now());
  insert into storage.objects (bucket_id, name, owner) values ('os', a::text || '/os-a.pdf', a);
  execute 'reset role';

  -- ===== B tenta ler e mexer nos dados de A =====
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  foreach t in array array['vehicles', 'fuel_logs', 'services', 'service_items', 'user_settings', 'user_places'] loop
    execute format('select count(*) from public.%I', t) into n;
    if n = 0 then ok_count := ok_count + 1; res := res || ('ok    B não lê ' || t);
    else fail_count := fail_count + 1; res := res || ('FALHOU B leu ' || n || ' linha(s) de ' || t); end if;
  end loop;

  select count(*) into n from storage.objects where bucket_id = 'os';
  if n = 0 then ok_count := ok_count + 1; res := res || 'ok    B não lê arquivos de OS de A'::text;
  else fail_count := fail_count + 1; res := res || 'FALHOU B leu arquivos de OS de A'::text; end if;

  update public.vehicles set name = 'invadido', updated_at = now() + interval '1 day' where id = va;
  get diagnostics n = row_count;
  if n = 0 then ok_count := ok_count + 1; res := res || 'ok    B não altera carro de A'::text;
  else fail_count := fail_count + 1; res := res || 'FALHOU B alterou carro de A'::text; end if;

  update public.user_places set label = 'invadido', updated_at = now() + interval '1 day' where label = 'Rua de A';
  get diagnostics n = row_count;
  if n = 0 then ok_count := ok_count + 1; res := res || 'ok    B não altera casa de A'::text;
  else fail_count := fail_count + 1; res := res || 'FALHOU B alterou casa de A'::text; end if;

  begin
    insert into public.fuel_logs (id, vehicle_id, date, odometer_km, liters, total_brl, price_per_l, fuel, full_tank, updated_at)
      values (gen_random_uuid(), va, current_date, 2000, 1, 1, 1, 'gasolina', true, now());
    fail_count := fail_count + 1; res := res || 'FALHOU B criou abastecimento no carro de A'::text;
  exception when others then ok_count := ok_count + 1; res := res || ('ok    B não cria abastecimento no carro de A (' || sqlerrm || ')');
  end;

  begin
    insert into public.vehicles (id, user_id, name, fuel_type, archived, updated_at) values (gen_random_uuid(), a, 'Plantado', 'flex', false, now());
  exception when others then null;
  end;
  begin
    insert into storage.objects (bucket_id, name, owner) values ('os', a::text || '/plantado.pdf', b);
    fail_count := fail_count + 1; res := res || 'FALHOU B gravou arquivo na pasta de A'::text;
  exception when others then ok_count := ok_count + 1; res := res || 'ok    B não grava arquivo na pasta de A'::text;
  end;

  begin
    delete from public.vehicles where id = va;
    fail_count := fail_count + 1; res := res || 'FALHOU B conseguiu usar DELETE'::text;
  exception when insufficient_privilege then ok_count := ok_count + 1; res := res || 'ok    DELETE negado'::text;
  end;

  begin
    truncate public.vehicles;
    fail_count := fail_count + 1; res := res || 'FALHOU B conseguiu TRUNCATE (apaga tudo de todos)'::text;
  exception when insufficient_privilege then ok_count := ok_count + 1; res := res || 'ok    TRUNCATE negado'::text;
  end;

  begin
    perform count(*) from public.api_usage;
    fail_count := fail_count + 1; res := res || 'FALHOU B lê a tabela de cotas'::text;
  exception when insufficient_privilege then ok_count := ok_count + 1; res := res || 'ok    tabela de cotas fechada'::text;
  end;
  execute 'reset role';

  -- O carro "plantado" por B com user_id de A não pode ter ido para A
  select count(*) into n from public.vehicles where user_id = a;
  if n = 1 then ok_count := ok_count + 1; res := res || 'ok    B não cria linha em nome de A'::text;
  else fail_count := fail_count + 1; res := res || ('FALHOU A tem ' || n || ' carros (esperado 1)'); end if;

  -- ===== Visitante sem login =====
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  execute 'set local role anon';
  foreach t in array array['vehicles', 'fuel_logs', 'services', 'service_items', 'user_settings', 'user_places', 'api_usage'] loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      if n = 0 then ok_count := ok_count + 1; res := res || ('ok    visitante não vê nada em ' || t);
      else fail_count := fail_count + 1; res := res || ('FALHOU visitante leu ' || t); end if;
    exception when insufficient_privilege then ok_count := ok_count + 1; res := res || ('ok    visitante sem acesso a ' || t);
    end;
  end loop;
  begin
    perform public.consume_quota('google_nearby', 99);
    fail_count := fail_count + 1; res := res || 'FALHOU visitante chamou consume_quota'::text;
  exception when insufficient_privilege then ok_count := ok_count + 1; res := res || 'ok    visitante não chama consume_quota'::text;
  end;
  execute 'reset role';

  raise exception 'RESULTADO % ok, % falhas%', ok_count, fail_count, E'\n' || array_to_string(res, E'\n');
end $$;
