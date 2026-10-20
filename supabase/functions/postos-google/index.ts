// Edge Function: dados do Google Places para o app (só usuários logados, verify_jwt).
//  - mode "nearby":  postos perto de um ponto, com nota, número de avaliações e endereço;
//  - mode "posto":   procura um posto específico pelo endereço (quando o "nearby" não achou);
//  - mode "address": busca de endereço para cadastrar casa e trabalho.
// A chave fica no segredo GOOGLE_MAPS_API_KEY; sem ela, devolve { configured: false }.
// Nada é guardado no servidor e nenhuma localização vai para o log.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const ALLOWED_ORIGINS = ['https://henriqueklock.github.io', 'http://localhost:5173', 'http://localhost:4173'];
const PLACES = 'https://places.googleapis.com/v1/places:';
const STATION_FIELDS = 'places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.formattedAddress';
const ADDRESS_FIELDS = 'places.id,places.displayName,places.location,places.formattedAddress,places.addressComponents,places.types';

function cors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

/** Exige um usuário logado de verdade. O gateway aceita a chave publicável como se fosse login (papel anon). */
async function currentUser(req: Request): Promise<string | null> {
  const url = Deno.env.get('SUPABASE_URL');
  const auth = req.headers.get('authorization') ?? '';
  const apikey = req.headers.get('apikey') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (!url || !/^Bearer eyJ/.test(auth)) return null;
  try {
    const r = await fetch(url + '/auth/v1/user', { headers: { apikey, Authorization: auth } });
    if (!r.ok) return null;
    const u = await r.json();
    return typeof u?.id === 'string' ? u.id : null;
  } catch {
    return null;
  }
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

const LIMITS: Record<string, number> = { nearby: 40, posto: 20, address: 30 };

const inBrazil = (lat: number, lon: number) => lat >= -34 && lat <= 6 && lon >= -74 && lon <= -34;

function station(p: any) {
  return {
    id: p.id,
    name: p.displayName?.text ?? '',
    address: p.formattedAddress ?? '',
    lat: p.location?.latitude,
    lon: p.location?.longitude,
    rating: typeof p.rating === 'number' ? p.rating : null,
    count: p.userRatingCount ?? 0,
  };
}

function address(p: any) {
  const comp = (type: string) => (p.addressComponents ?? []).find((c: any) => (c.types ?? []).includes(type))?.longText ?? '';
  return {
    id: p.id,
    name: p.displayName?.text ?? '',
    address: p.formattedAddress ?? '',
    lat: p.location?.latitude,
    lon: p.location?.longitude,
    route: comp('route'),
    hood: comp('sublocality_level_1') || comp('sublocality') || comp('neighborhood'),
    city: comp('administrative_area_level_2') || comp('locality'),
    state: (p.addressComponents ?? []).find((c: any) => (c.types ?? []).includes('administrative_area_level_1'))?.shortText ?? '',
    types: p.types ?? [],
  };
}

Deno.serve(async (req) => {
  const headers = cors(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  const json = (status: number, data: unknown) =>
    new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });

  if (!(await currentUser(req))) return json(401, { error: 'Entre na sua conta para usar esta função.' });

  const key = Deno.env.get('GOOGLE_MAPS_API_KEY');
  if (!key) return json(200, { configured: false, places: [] });

  let b: any;
  try {
    b = await req.json();
  } catch {
    return json(400, { error: 'Corpo inválido.' });
  }
  const mode = b.mode ?? 'nearby';
  const lat = Number(b.lat), lon = Number(b.lon);
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lon) && inBrazil(lat, lon);

  let url: string, fields: string, body: Record<string, unknown>;
  if (mode === 'nearby') {
    if (!hasPoint) return json(400, { error: 'Envie lat e lon de um ponto no Brasil.' });
    const radius = Math.min(Math.max(Number(b.radius_m) || 3000, 200), 20000);
    url = PLACES + 'searchNearby';
    fields = STATION_FIELDS;
    body = { includedTypes: ['gas_station'], maxResultCount: 20, rankPreference: 'DISTANCE', languageCode: 'pt-BR', regionCode: 'BR', locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius } } };
  } else if (mode === 'posto' || mode === 'address') {
    const q = String(b.query ?? '').trim().slice(0, 200);
    if (q.length < 3) return json(400, { error: 'Busca muito curta.' });
    url = PLACES + 'searchText';
    fields = mode === 'posto' ? STATION_FIELDS : ADDRESS_FIELDS;
    body = { textQuery: q, languageCode: 'pt-BR', regionCode: 'BR', pageSize: mode === 'posto' ? 5 : 6 };
    if (mode === 'posto') body.includedType = 'gas_station';
    if (hasPoint) body.locationBias = { circle: { center: { latitude: lat, longitude: lon }, radius: mode === 'posto' ? 3000 : 30000 } };
  } else {
    return json(400, { error: 'Modo desconhecido.' });
  }

  if (!(await withinQuota(req, 'google_' + mode, LIMITS[mode]))) {
    console.log(JSON.stringify({ event: 'postos-google-cota', mode }));
    return json(429, { error: 'Limite diário de buscas no Google atingido para esta conta. Tente amanhã.' });
  }
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fields }, body: JSON.stringify(body) });
  if (!r.ok) {
    console.error(JSON.stringify({ event: 'postos-google-error', mode, status: r.status, body: (await r.text()).slice(0, 300) }));
    if (r.status === 429) return json(429, { error: 'A cota diária do Google do app acabou. Volta a funcionar amanhã.' });
    return json(502, { error: 'O Google não respondeu agora.' });
  }
  const data = await r.json();
  const places = (data.places ?? []).map(mode === 'address' ? address : station);
  console.log(JSON.stringify({ event: 'postos-google', mode, n: places.length }));
  return json(200, { configured: true, places });
});
