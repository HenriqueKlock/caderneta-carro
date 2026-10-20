// Edge Function: notas do Google para os postos perto de um ponto (Places API, Nearby Search).
// Só responde a usuários logados (verify_jwt). A chave fica no segredo GOOGLE_MAPS_API_KEY;
// sem ela, devolve { configured: false } e o app usa só a fiscalização da ANP.
// Nada é guardado no servidor: a resposta vai direto para o aparelho.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

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

  const key = Deno.env.get('GOOGLE_MAPS_API_KEY');
  if (!key) return json(200, { configured: false, places: [] });

  let lat: number, lon: number, radius: number;
  try {
    const b = await req.json();
    lat = Number(b.lat);
    lon = Number(b.lon);
    radius = Math.min(Math.max(Number(b.radius_m) || 3000, 200), 20000);
    if (!(lat >= -34 && lat <= 6 && lon >= -74 && lon <= -34)) throw new Error('fora do Brasil');
  } catch {
    return json(400, { error: 'Envie lat e lon de um ponto no Brasil.' });
  }

  const r = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.rating,places.userRatingCount',
    },
    body: JSON.stringify({
      includedTypes: ['gas_station'],
      maxResultCount: 20,
      rankPreference: 'DISTANCE',
      languageCode: 'pt-BR',
      locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius } },
    }),
  });
  if (!r.ok) {
    console.error(JSON.stringify({ event: 'postos-google-error', status: r.status, body: (await r.text()).slice(0, 300) }));
    return json(502, { error: 'O Google não respondeu agora.' });
  }
  const data = await r.json();
  const places = (data.places ?? []).map((p: any) => ({
    id: p.id,
    name: p.displayName?.text ?? '',
    lat: p.location?.latitude,
    lon: p.location?.longitude,
    rating: typeof p.rating === 'number' ? p.rating : null,
    count: p.userRatingCount ?? 0,
  }));
  console.log(JSON.stringify({ event: 'postos-google', n: places.length, radius }));
  return json(200, { configured: true, places });
});
