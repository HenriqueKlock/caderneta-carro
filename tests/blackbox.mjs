// Teste de caixa preta: faz o que um estranho faria só com o que está público no site
// (a URL do Supabase e a chave publicável) e confere que nada vaza. Roda a cada deploy.
// Uso: node tests/blackbox.mjs [pasta-do-build]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const cfg = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
const URL_ = cfg.match(/SUPABASE_URL = '([^']+)'/)[1];
const KEY = cfg.match(/SUPABASE_PUBLISHABLE_KEY = '([^']+)'/)[1];
const TABLES = ['vehicles', 'fuel_logs', 'services', 'service_items', 'user_settings', 'user_places', 'api_usage'];
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhYWFhYWFhYS0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMGEiLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImV4cCI6NDEwMjQ0NDgwMH0.assinatura-falsa';

let fails = 0;
const ok = (m) => console.log('ok     ' + m);
const bad = (m) => { fails++; console.log('FALHOU ' + m); };

async function call(path, { method = 'GET', body, auth } = {}) {
  const headers = { apikey: KEY, 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = auth;
  const r = await fetch(URL_ + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch { /* sem corpo */ }
  return { status: r.status, data };
}
const closed = (r) => r.status >= 400 || (Array.isArray(r.data) && r.data.length === 0);

// 1) Tabelas: ler, criar, alterar e apagar sem login (e com um login forjado)
for (const t of TABLES) {
  for (const [who, auth] of [['sem login', undefined], ['com token forjado', 'Bearer ' + FAKE_JWT]]) {
    const r = await call(`/rest/v1/${t}?select=*&limit=5`, { auth });
    closed(r) ? ok(`${t}: leitura ${who} bloqueada (${r.status})`) : bad(`${t}: leitura ${who} devolveu ${r.data.length} linha(s)`);
  }
  const ins = await call(`/rest/v1/${t}`, { method: 'POST', body: { updated_at: new Date().toISOString() } });
  ins.status >= 400 ? ok(`${t}: criação sem login bloqueada (${ins.status})`) : bad(`${t}: criou linha sem login`);
  const upd = await call(`/rest/v1/${t}?updated_at=gt.1970-01-01`, { method: 'PATCH', body: { updated_at: '2100-01-01T00:00:00Z' } });
  closed(upd) || upd.status === 204 ? ok(`${t}: alteração sem login sem efeito (${upd.status})`) : bad(`${t}: alteração sem login respondeu ${upd.status}`);
  const del = await call(`/rest/v1/${t}?updated_at=gt.1970-01-01`, { method: 'DELETE' });
  del.status >= 400 ? ok(`${t}: exclusão bloqueada (${del.status})`) : bad(`${t}: exclusão respondeu ${del.status}`);
}

// 2) Função de cota não pode ser chamada sem login
const rpc = await call('/rest/v1/rpc/consume_quota', { method: 'POST', body: { p_fn: 'google_nearby', p_max: 999 } });
rpc.status >= 400 ? ok(`consume_quota sem login bloqueada (${rpc.status})`) : bad('consume_quota respondeu sem login');

// 3) Arquivos de OS
const list = await call('/storage/v1/object/list/os', { method: 'POST', body: { prefix: '', limit: 100 } });
closed(list) ? ok(`arquivos de OS: listagem sem login vazia/bloqueada (${list.status})`) : bad(`arquivos de OS: listou ${list.data.length} item(ns) sem login`);
const pub = await fetch(URL_ + '/storage/v1/object/public/os/qualquer.pdf');
pub.status >= 400 ? ok(`arquivos de OS: sem link público (${pub.status})`) : bad('arquivos de OS acessíveis por link público');

// 4) Funções do servidor exigem login de verdade
for (const fn of ['postos-google', 'parse-os']) {
  for (const [who, auth] of [['sem login', undefined], ['com token forjado', 'Bearer ' + FAKE_JWT]]) {
    const r = await call(`/functions/v1/${fn}`, { method: 'POST', body: { mode: 'address', query: 'teste', lat: -27.6, lon: -48.5 }, auth });
    r.status === 401 ? ok(`${fn}: ${who} recusado (401)`) : bad(`${fn}: ${who} respondeu ${r.status}`);
  }
}

// 5) Área administrativa do login
const adm = await call('/auth/v1/admin/users');
adm.status >= 400 ? ok(`admin do login bloqueado (${adm.status})`) : bad('admin do login respondeu à chave pública');

// 6) Nenhuma chave secreta no site publicado (chave secreta do Supabase, token service_role em base64, Claude, Google)
const dist = process.argv[2];
if (dist) {
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  const leaks = walk(dist).filter((f) => /\.(js|html|json|webmanifest|css)$/.test(f)).filter((f) => /sb_secret_[A-Za-z0-9_-]{16,}|c2VydmljZV9yb2xl|NlcnZpY2Vfcm9sZ|zZXJ2aWNlX3JvbG|sk-ant-[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{30}/.test(readFileSync(f, 'utf8')));
  leaks.length ? bad('possível chave secreta em: ' + leaks.join(', ')) : ok('nenhuma chave secreta no site publicado');
}

console.log(fails ? `\n${fails} problema(s) de segurança` : '\nTudo fechado.');
process.exit(fails ? 1 : 0);
