// Postos: distância, confiabilidade e recomendação (puro, sem DOM — testado em tests/postos.test.ts).

export type PriceCode = 'gc' | 'ga' | 'et' | 'd10' | 'ds' | 'gnv';
/** Ocorrência da fiscalização: I infração, D interdição, A apreensão, S suspensão, N notificação, M medida reparadora. */
export type EventType = 'I' | 'D' | 'A' | 'S' | 'N' | 'M';

export interface Station {
  c: string; // CNPJ
  n: string;
  b: string;
  e: string;
  br: string;
  m: string;
  la: number;
  lo: number;
  pg: 'n' | 'r' | 'b'; // precisão do ponto: número, rua, bairro
  pr?: Partial<Record<PriceCode, [number, string]>>;
  f?: { n: number; ult: string; ev: [string, EventType, string][] };
}

export interface StationsFile {
  v: number;
  uf: string[];
  gerado: string;
  fontes: { lpc_semanas: [string, string][]; fisc_desde: string; fisc_ate: string | null; cadastro: string };
  postos: Station[];
}

export interface LatLon { lat: number; lon: number }
export type Fuel = 'gasolina' | 'etanol';

/* ---------- geometria ---------- */
const R = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Fator de ruas: a distância em linha reta subestima o trajeto de carro. */
export const ROAD = 1.3;

/** Menor distância (km, em linha reta) de um ponto até uma linha (lista de pontos lat/lon). */
export function distToPathKm(p: LatLon, path: LatLon[]): number {
  if (!path.length) return Infinity;
  if (path.length === 1) return haversineKm(p, path[0]);
  const kx = 111.32 * Math.cos(rad(p.lat)), ky = 110.57;
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const ax = (path[i - 1].lon - p.lon) * kx, ay = (path[i - 1].lat - p.lat) * ky;
    const bx = (path[i].lon - p.lon) * kx, by = (path[i].lat - p.lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) best = d;
  }
  return best;
}

/** Simplifica uma linha (Douglas–Peucker) para guardar a rota com poucos pontos. Tolerância em km. */
export function simplify(path: LatLon[], tolKm = 0.03): LatLon[] {
  if (path.length < 3) return path.slice();
  const keep = new Uint8Array(path.length);
  keep[0] = keep[path.length - 1] = 1;
  const stack: [number, number][] = [[0, path.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let idx = -1, max = 0;
    for (let k = i + 1; k < j; k++) {
      const d = distToPathKm(path[k], [path[i], path[j]]);
      if (d > max) { max = d; idx = k; }
    }
    if (idx > 0 && max > tolKm) {
      keep[idx] = 1;
      stack.push([i, idx], [idx, j]);
    }
  }
  return path.filter((_, k) => keep[k]);
}

export function bboxAround(c: LatLon, km: number) {
  const dLat = km / 110.57, dLon = km / (111.32 * Math.cos(rad(c.lat)));
  return { s: c.lat - dLat, n: c.lat + dLat, w: c.lon - dLon, e: c.lon + dLon };
}

/* ---------- confiabilidade ---------- */
// Infração ligada ao combustível ou à bomba pesa 1,2; a de papelada/cadastro, 0,5
const PESO: Record<EventType, number> = { D: 2.2, S: 2.2, A: 1.6, I: 0.5, M: 0.15, N: 0.1 };
const PESO_COMBUSTIVEL = 1.2;
export const EVENT_LABEL: Record<EventType, string> = {
  I: 'Auto de infração', D: 'Interdição', A: 'Apreensão', S: 'Suspensão', N: 'Notificação', M: 'Medida reparadora',
};

/** Infração ligada ao combustível ou à bomba (qualidade/quantidade), não só a papelada. */
export function aboutFuel(text: string): boolean {
  return /volume|quantidade|qualidade|especifica|adulter|teor|massa espec|afer(i|ç)|lacre|metanol|solvente|fraude|a menor/i.test(text);
}

function yearsBetween(a: string, b: string) {
  return (Date.parse(b) - Date.parse(a)) / (365.25 * 86400000);
}

export interface Reliability {
  score: number; // 0–5
  anp: number; // 0–5
  google: number | null; // nota ajustada, 0–5
  level: 'ok' | 'atencao' | 'evitar';
  /** Ocorrência grave (interdição, apreensão, suspensão ou infração) nos últimos 12 meses. */
  recentSerious: boolean;
  infractions: number;
  interdictions: number;
  visits: number;
}

/**
 * ANP (peso maior): parte de 5 e desconta cada ocorrência dos últimos 5 anos, mais forte quanto mais recente.
 * Google: média bayesiana (nota puxada para 4,0 quando há poucas avaliações).
 * Ocorrência grave nos últimos 12 meses limita a nota em 2,5 (fica fora da recomendação).
 */
export function reliability(s: Station, today: string, g?: { rating: number; count: number } | null): Reliability {
  const ev = s.f?.ev ?? [];
  let anp = s.f ? 5 : 4.2; // sem fiscalização registrada: neutro, não perfeito
  let recentSerious = false, inf = 0, intd = 0;
  for (const [date, t, text] of ev) {
    const y = yearsBetween(date, today);
    if (y > 5) continue;
    const w = y < 1 ? 1 : y < 2 ? 0.7 : y < 3 ? 0.5 : 0.3;
    const fuelIssue = t === 'I' && aboutFuel(text);
    anp -= (fuelIssue ? PESO_COMBUSTIVEL : PESO[t]) * w;
    if (t === 'I') inf++;
    if (t === 'D' || t === 'S' || t === 'A') intd++;
    if (y < 1 && (t === 'D' || t === 'S' || t === 'A' || fuelIssue)) recentSerious = true;
  }
  anp = Math.max(0, Math.min(5, anp));
  let google: number | null = null;
  if (g && g.count > 0 && Number.isFinite(g.rating)) {
    const m = 30;
    google = (g.rating * g.count + 4.0 * m) / (g.count + m);
  }
  let score = google == null ? anp : 0.65 * anp + 0.35 * google;
  if (recentSerious) score = Math.min(score, 2.5);
  score = Math.round(score * 10) / 10;
  const level = score >= 3.8 ? 'ok' : score >= 3 ? 'atencao' : 'evitar';
  return { score, anp: Math.round(anp * 10) / 10, google: google == null ? null : Math.round(google * 10) / 10, level, recentSerious, infractions: inf, interdictions: intd, visits: s.f?.n ?? 0 };
}

/* ---------- preços ---------- */
export interface PricePoint { price: number; date: string; src: 'anp' | 'voce' }
export interface OwnPrice { station_id: string; fuel: Fuel; price: number; date: string }

/** Preço mais recente: o que você pagou vale mais que a pesquisa da ANP quando é mais novo ou do mesmo dia. */
export function priceOf(s: Station, fuel: Fuel, own: OwnPrice[]): PricePoint | null {
  const code: PriceCode = fuel === 'gasolina' ? 'gc' : 'et';
  const anp = s.pr?.[code];
  const mine = own.filter((o) => o.station_id === s.c && o.fuel === fuel).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (mine && (!anp || mine.date >= anp[1])) return { price: mine.price, date: mine.date, src: 'voce' };
  return anp ? { price: anp[0], date: anp[1], src: 'anp' } : null;
}

export function ageDays(date: string, today: string) {
  return Math.round((Date.parse(today) - Date.parse(date)) / 86400000);
}

/* ---------- recomendação ---------- */
export type Base =
  | { kind: 'ponto'; at: LatLon; radiusKm: number }
  | { kind: 'rota'; path: LatLon[]; detourKm: number };

export interface CarModel {
  kmlG: number; // km/l na gasolina
  kmlE: number; // km/l no etanol
  measured: boolean; // rendimento do etanol medido nos seus tanques (senão, 70%)
  fuels: Fuel[]; // combustíveis que o carro aceita
  /** km rodados com um tanque típico de gasolina: base para comparar custos. */
  kmTank: number;
}

export interface Option {
  s: Station;
  fuel: Fuel;
  price: PricePoint;
  /** km extras para ir ao posto e voltar ao caminho (ida e volta, já com o fator de ruas). */
  extraKm: number;
  /** Distância mostrada ao usuário (km por ruas, aproximada). */
  distKm: number;
  costPerKm: number;
  /** Custo para rodar `kmTank` km com esse combustível, somando o desvio. */
  cost: number;
  rel: Reliability;
  stale: boolean;
}

export interface StationRow {
  s: Station;
  distKm: number;
  extraKm: number;
  gas: PricePoint | null;
  eth: PricePoint | null;
  rel: Reliability;
  opts: Option[]; // opções deste posto, da mais barata para a mais cara
  best: Option | null; // melhor combustível neste posto
}

export const MAX_PRICE_AGE = 30;

/** Postos dentro da base (raio ou desvio máximo da rota), com distância, preços e confiabilidade. */
export function stationsFor(
  all: Station[], base: Base, car: CarModel, own: OwnPrice[], today: string,
  google?: Map<string, { rating: number; count: number }>,
): StationRow[] {
  const rows: StationRow[] = [];
  for (const s of all) {
    const p = { lat: s.la, lon: s.lo };
    let distKm: number, extraKm: number;
    if (base.kind === 'ponto') {
      const d = haversineKm(base.at, p) * ROAD;
      if (d > base.radiusKm) continue;
      distKm = d;
      extraKm = 2 * d;
    } else {
      const d = distToPathKm(p, base.path) * ROAD;
      if (d > base.detourKm) continue;
      distKm = d;
      extraKm = 2 * d;
    }
    const rel = reliability(s, today, google?.get(s.c));
    const gas = priceOf(s, 'gasolina', own);
    const eth = priceOf(s, 'etanol', own);
    const opts: Option[] = [];
    for (const [fuel, pp] of [['gasolina', gas], ['etanol', eth]] as const) {
      if (!pp || !car.fuels.includes(fuel)) continue;
      const kml = fuel === 'gasolina' ? car.kmlG : car.kmlE;
      const cpk = pp.price / kml;
      opts.push({ s, fuel, price: pp, extraKm, distKm, costPerKm: cpk, cost: cpk * (car.kmTank + extraKm), rel, stale: ageDays(pp.date, today) > MAX_PRICE_AGE });
    }
    opts.sort((a, b) => a.cost - b.cost);
    rows.push({ s, distKm, extraKm, gas, eth, rel, opts, best: opts[0] ?? null });
  }
  return rows;
}

/** Data do preço mais novo do posto (entre os combustíveis que o carro usa), ou null. */
export function priceDate(r: StationRow): string | null {
  return r.opts.reduce<string | null>((d, o) => (!d || o.price.date > d ? o.price.date : d), null);
}

/**
 * Ordem da lista: primeiro os preços mais recentes (e, no mesmo dia, o mais em conta);
 * depois os de confiabilidade baixa e os de preço antigo; por fim os sem preço, pela nota e pela distância.
 */
export function sortRows(rows: StationRow[]): StationRow[] {
  const group = (r: StationRow) => (!r.best ? 3 : r.best.stale ? 2 : r.rel.level === 'evitar' ? 1 : 0);
  return rows.slice().sort((a, b) => {
    const ga = group(a), gb = group(b);
    if (ga !== gb) return ga - gb;
    if (ga < 3) {
      const da = priceDate(a)!, db = priceDate(b)!;
      if (da !== db) return db.localeCompare(da);
      return a.best!.cost - b.best!.cost;
    }
    return b.rel.score - a.rel.score || a.distKm - b.distKm;
  });
}

/** Sem nenhum preço recente: o posto de melhor nota e mais perto (cada km de distância vale 0,25 de nota). */
export function bestWithoutPrice(rows: StationRow[]): StationRow | null {
  const cands = rows.filter((r) => r.rel.level !== 'evitar');
  if (!cands.length) return null;
  return cands.slice().sort((a, b) => (b.rel.score - 0.25 * b.distKm) - (a.rel.score - 0.25 * a.distKm))[0];
}

/* ---------- seu posto: uso e rendimento dos tanques ---------- */
export interface FillLike { id: string; date: string; station_id?: string | null; station?: string | null; fuel: string; full_tank: boolean }
export interface TankLike { start_id: string; kml: number; fuel: string }
export interface StationUse {
  station_id: string;
  name: string | null;
  fills: number;
  last: string;
  tanks: number;
  kml: number | null;
  /** Rendimento dos tanques deste posto vs. a sua média do mesmo combustível (0,03 = 3% acima). */
  delta: number | null;
}

/** Postos usados, do mais frequente (últimos 12 meses) para o menos; o rendimento conta o tanque que começou ali. */
export function stationUsage(fills: FillLike[], tanks: TankLike[], today: string): StationUse[] {
  const byId = new Map(fills.map((f) => [f.id, f]));
  const avg = new Map<string, number>();
  for (const fuel of new Set(tanks.map((t) => t.fuel))) {
    const ts = tanks.filter((t) => t.fuel === fuel);
    avg.set(fuel, ts.reduce((a, t) => a + t.kml, 0) / ts.length);
  }
  const map = new Map<string, StationUse & { ratios: number[]; kmls: number[]; recent: number }>();
  for (const f of fills) {
    if (!f.station_id) continue;
    const u = map.get(f.station_id) ?? { station_id: f.station_id, name: f.station ?? null, fills: 0, last: f.date, tanks: 0, kml: null, delta: null, ratios: [], kmls: [], recent: 0 };
    u.fills++;
    if (ageDays(f.date, today) <= 365) u.recent++;
    if (f.date >= u.last) { u.last = f.date; u.name = f.station ?? u.name; }
    map.set(f.station_id, u);
  }
  for (const t of tanks) {
    const f = byId.get(t.start_id);
    const u = f?.station_id ? map.get(f.station_id) : undefined;
    const a = avg.get(t.fuel);
    if (!u || !a || t.fuel === 'misto') continue;
    u.tanks++;
    u.kmls.push(t.kml);
    u.ratios.push(t.kml / a);
  }
  return [...map.values()]
    .map(({ ratios, kmls, recent, ...u }) => ({
      ...u,
      kml: kmls.length ? kmls.reduce((a, b) => a + b, 0) / kmls.length : null,
      delta: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length - 1 : null,
      _recent: recent,
    }))
    .sort((a, b) => b._recent - a._recent || b.fills - a.fills || b.last.localeCompare(a.last))
    .map(({ _recent, ...u }) => u);
}

/** Frase curta sobre o rendimento; só afirma algo com 2 tanques ou mais. */
export function usageVerdict(u: StationUse): { tone: 'ok' | 'bad' | 'neutral'; text: string } | null {
  if (u.delta == null || u.tanks === 0) return null;
  const pct = Math.round(Math.abs(u.delta) * 100);
  if (u.tanks < 2) return { tone: 'neutral', text: '1 tanque medido daqui; com mais um dá para comparar com a sua média.' };
  if (pct < 3) return { tone: 'ok', text: 'Seus tanques daqui rendem como a sua média (' + u.tanks + ' tanques).' };
  if (u.delta > 0) return { tone: 'ok', text: 'Seus tanques daqui rendem ' + pct + '% acima da sua média (' + u.tanks + ' tanques).' };
  return {
    tone: pct >= 5 && u.tanks >= 3 ? 'bad' : 'neutral',
    text: 'Seus tanques daqui rendem ' + pct + '% abaixo da sua média (' + u.tanks + ' tanques)' + (pct >= 5 && u.tanks >= 3 ? ': pode ser combustível ou bomba; vale comparar com outro posto.' : '.'),
  };
}

export interface Recommendation {
  best: Option | null;
  /** Melhor opção do outro combustível (para mostrar quanto a escolha economiza). */
  bestOther: Option | null;
  /** Opção mais barata deixada de lado por confiabilidade baixa, para avisar. */
  cheaperUnsafe: Option | null;
  considered: number;
}

export function recommend(rows: StationRow[]): Recommendation {
  const all = rows.flatMap((r) => r.opts).filter((o) => !o.stale);
  const good = all.filter((o) => o.rel.level !== 'evitar').sort((a, b) => a.cost - b.cost);
  const best = good[0] ?? null;
  const bestOther = best ? good.find((o) => o.fuel !== best.fuel) ?? null : null;
  const unsafe = all.filter((o) => o.rel.level === 'evitar').sort((a, b) => a.cost - b.cost)[0] ?? null;
  return { best, bestOther, cheaperUnsafe: unsafe && best && unsafe.cost < best.cost ? unsafe : null, considered: good.length };
}

/* ---------- casar postos do Google com os da ANP ---------- */
export interface GoogleStation { id: string; name: string; address: string; lat: number; lon: number; rating: number | null; count: number }
export interface GoogleMatch { id: string; name: string; rating: number | null; count: number; lat: number; lon: number }

const STOP = new Set('posto postos auto autoposto ltda me epp eireli sa s a comercio com de da do das dos e combustiveis combustivel derivados petroleo servicos servico serv conveniencia rede abastecimento center centro and the loja filial'.split(' '));
const BRANDS: Record<string, string> = { shell: 'Shell', raizen: 'Shell', ipiranga: 'Ipiranga', petrobras: 'Petrobras', br: 'Petrobras', vibra: 'Petrobras', ale: 'Ale', alesat: 'Ale' };

function words(s: string): string[] {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
function nameTokens(s: string) {
  return words(s).filter((w) => w.length >= 3 && !STOP.has(w) && !BRANDS[w] && !/^\d+$/.test(w));
}
function brandOf(s: string): string | null {
  for (const w of words(s)) if (BRANDS[w]) return BRANDS[w];
  return null;
}

/** Pontua o quanto um lugar do Google parece ser este posto (endereço, nome, bandeira e distância). */
export function matchScore(g: GoogleStation, s: Station): number {
  const d = haversineKm({ lat: s.la, lon: s.lo }, g);
  const maxD = s.pg === 'n' ? 1.0 : 2.5; // ponto pelo bairro ou pela rua pode estar longe
  if (d > maxD) return 0;
  const gAddr = words(g.address);
  const num = (s.e.match(/,\s*(\d{1,6})\s*$/) ?? [])[1];
  const street = nameTokens(s.e.replace(/,\s*\d+\s*$/, ''));
  const addr = !!num && gAddr.includes(num) && street.some((w) => gAddr.includes(w));
  const gName = new Set(nameTokens(g.name));
  const overlap = nameTokens(s.n).filter((w) => gName.has(w)).length;
  const gBrand = brandOf(g.name), sBrand = s.b in { Shell: 1, Ipiranga: 1, Petrobras: 1, Ale: 1 } ? s.b : null;
  let score = (addr ? 3 : 0) + Math.min(overlap, 2) * 1.5 + (gBrand && gBrand === sBrand ? 1 : 0);
  score += d < 0.1 ? 2 : d < 0.25 ? 1.2 : d < 0.5 ? 0.6 : 0;
  if (gBrand && sBrand && gBrand !== sBrand) score -= 2;
  const evidence = addr || overlap > 0 || (gBrand && gBrand === sBrand) || d < 0.15;
  return evidence && score >= 1.5 ? score : 0;
}

/** Liga cada lugar do Google a no máximo um posto da ANP (os pares mais parecidos primeiro). */
export function matchGoogle(places: GoogleStation[], stations: Station[]): Map<string, GoogleMatch> {
  const pairs: { g: GoogleStation; s: Station; v: number }[] = [];
  for (const g of places) {
    if (!Number.isFinite(g.lat) || !Number.isFinite(g.lon)) continue;
    for (const s of stations) {
      const v = matchScore(g, s);
      if (v > 0) pairs.push({ g, s, v });
    }
  }
  pairs.sort((a, b) => b.v - a.v);
  const usedG = new Set<string>(), out = new Map<string, GoogleMatch>();
  for (const { g, s } of pairs) {
    if (usedG.has(g.id) || out.has(s.c)) continue;
    usedG.add(g.id);
    out.set(s.c, { id: g.id, name: g.name, rating: g.rating, count: g.count, lat: g.lat, lon: g.lon });
  }
  return out;
}
