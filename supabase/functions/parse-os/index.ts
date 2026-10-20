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

Deno.serve(async (req) => {
  const headers = cors(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  const json = (status: number, data: unknown) =>
    new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return json(503, { error: 'A leitura de OS ainda não está configurada (falta a chave da API do Claude).' });

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
