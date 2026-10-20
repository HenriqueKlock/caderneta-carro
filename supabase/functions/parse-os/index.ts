// Edge Function: lê a OS (PDF ou foto) com a API do Claude e devolve um rascunho para o app revisar.
// A chave fica no segredo ANTHROPIC_API_KEY; o JWT do usuário é exigido (verify_jwt).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { extractOS, InputError, validateInput } from './extract.ts';

const ALLOWED_ORIGINS = ['https://henriqueklock.github.io', 'http://localhost:5173', 'http://localhost:4173'];

function cors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

/** Cota diária por usuário (tabela api_usage). Sem confirmação da cota, não chama o serviço pago. */
async function withinQuota(req: Request, fn: string, max: number): Promise<boolean> {
  const url = Deno.env.get('SUPABASE_URL');
  const apikey = req.headers.get('apikey') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const auth = req.headers.get('authorization') ?? '';
  if (!url || !auth) return false;
  try {
    const r = await fetch(url + '/rest/v1/rpc/consume_quota', {
      method: 'POST',
      headers: { apikey, Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_fn: fn, p_max: max }),
    });
    return r.ok && (await r.json()) === true;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  const headers = cors(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  const json = (status: number, data: unknown) =>
    new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return json(503, { error: 'A leitura de OS ainda não está configurada (falta a chave da API do Claude).' });

  if (!(await withinQuota(req, 'parse_os', 15))) return json(429, { error: 'Limite diário de leituras de OS atingido para esta conta. Tente amanhã.' });

  try {
    const input = validateInput(await req.json());
    const result = await extractOS(input, apiKey, fetch, Deno.env.get('CLAUDE_MODEL') ?? undefined);
    console.log(JSON.stringify({ event: 'parse-os', items: result.draft.items.length, usage: result.usage }));
    return json(200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'parse-os-error', message }));
    return json(err instanceof InputError ? 400 : 502, { error: message });
  }
});
