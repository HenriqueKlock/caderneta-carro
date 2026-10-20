// Localização e mapas: GPS do aparelho, busca de endereço (Nominatim/OpenStreetMap),
// rota entre casa e trabalho (OSRM, servidor público gratuito) e o arquivo público de postos.
import { simplify, type LatLon, type StationsFile } from './postos';

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OSRM = 'https://router.project-osrm.org/route/v1/driving/';

export interface FoundPlace extends LatLon { label: string; detail: string }

export function gps(): Promise<LatLon> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Este aparelho não informa a localização.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) =>
        reject(new Error(e.code === e.PERMISSION_DENIED
          ? 'Permissão de localização negada. Libere nas configurações do navegador ou escolha um endereço.'
          : 'Não consegui pegar a localização agora. Tente de novo ou escolha um endereço.')),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 5 * 60 * 1000 },
    );
  });
}

function labelOf(a: Record<string, string | undefined>, fallback: string): { label: string; detail: string } {
  // Sem número da casa: guardamos só rua e bairro
  const road = a.road || a.pedestrian || a.residential || a.square || '';
  const hood = a.suburb || a.neighbourhood || a.quarter || a.city_district || '';
  const city = a.city || a.town || a.village || a.municipality || '';
  const label = [road, hood].filter(Boolean).join(' · ') || hood || city || fallback.split(',')[0];
  const detail = [hood && road ? '' : hood, city, a.state].filter(Boolean).join(', ');
  return { label: label.slice(0, 100), detail };
}

async function getJSON(url: string) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('Serviço de mapas respondeu ' + r.status);
  return r.json();
}

/** Busca endereço, bairro ou cidade (uma consulta por toque em Buscar, como pede o Nominatim). */
export async function searchAddress(q: string, near?: LatLon | null): Promise<FoundPlace[]> {
  const params = new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', limit: '6', countrycodes: 'br', 'accept-language': 'pt-BR' });
  if (near) {
    const d = 1.5;
    params.set('viewbox', [near.lon - d, near.lat + d, near.lon + d, near.lat - d].join(','));
  }
  try {
    const list = (await getJSON(NOMINATIM + '/search?' + params)) as any[];
    const seen = new Set<string>();
    return list
      .map((r) => ({ lat: Number(r.lat), lon: Number(r.lon), ...labelOf(r.address ?? {}, r.display_name ?? q) }))
      .filter((r) => {
        const k = r.label + r.detail;
        if (seen.has(k)) return false;
        seen.add(k);
        return Number.isFinite(r.lat);
      });
  } catch (e) {
    throw new Error(navigator.onLine === false ? 'Sem internet para buscar endereços.' : 'A busca de endereços não respondeu. Tente de novo.');
  }
}

export async function reverse(p: LatLon): Promise<FoundPlace> {
  try {
    const r = await getJSON(NOMINATIM + '/reverse?' + new URLSearchParams({ lat: String(p.lat), lon: String(p.lon), format: 'jsonv2', zoom: '17', addressdetails: '1', 'accept-language': 'pt-BR' }));
    return { ...p, ...labelOf(r.address ?? {}, r.display_name ?? 'Local atual') };
  } catch {
    return { ...p, label: 'Local marcado pelo GPS', detail: '' };
  }
}

export interface Route { pts: [number, number][]; km: number; min: number; from: [number, number]; to: [number, number] }

/** Rota de carro entre dois pontos, simplificada para poucos pontos (fica guardada na conta). */
export async function route(a: LatLon, b: LatLon): Promise<Route> {
  const url = OSRM + `${a.lon.toFixed(5)},${a.lat.toFixed(5)};${b.lon.toFixed(5)},${b.lat.toFixed(5)}?overview=full&geometries=geojson&alternatives=false&steps=false`;
  let data: any;
  try {
    data = await getJSON(url);
  } catch {
    throw new Error(navigator.onLine === false ? 'Sem internet para calcular o caminho.' : 'O serviço de rotas não respondeu. Tente de novo mais tarde.');
  }
  const r = data?.routes?.[0];
  if (!r) throw new Error('Não achei um caminho de carro entre os dois endereços.');
  const path = (r.geometry.coordinates as [number, number][]).map(([lon, lat]) => ({ lat, lon }));
  const pts = simplify(path, 0.03).map((p) => [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lon * 1e5) / 1e5] as [number, number]);
  return { pts, km: Math.round(r.distance / 100) / 10, min: Math.round(r.duration / 60), from: [a.lat, a.lon], to: [b.lat, b.lon] };
}

/* ---------- arquivo público de postos (gerado toda semana a partir da ANP) ---------- */
let cache: Promise<StationsFile | null> | null = null;
export function loadStations(uf = 'SC'): Promise<StationsFile | null> {
  if (!cache) {
    cache = fetch(import.meta.env.BASE_URL + 'dados/postos-' + uf + '.json')
      .then((r) => (r.ok ? (r.json() as Promise<StationsFile>) : null))
      .catch(() => null)
      .then((f) => {
        if (!f) cache = null; // tenta de novo na próxima abertura
        return f;
      });
  }
  return cache;
}
