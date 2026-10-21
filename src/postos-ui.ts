// Telas de postos: aba Postos, ficha do posto, "Outro local", Casa e trabalho e o card "Onde abastecer" do Início.
import {
  EVENT_LABEL, ageDays, bboxAround, bestWithoutPrice, haversineKm, matchGoogle, recommend, sortRows, stationsFor, usageVerdict,
  type GoogleMatch, type GoogleStation, type StationUse,
  type Base, type CarModel, type Fuel, type LatLon, type Option, type OwnPrice, type Recommendation, type Station, type StationRow, type StationsFile,
} from './postos';
import { gps, loadStations, reverse, route, searchPlaces, type FoundPlace, type Route } from './lugares';
import { currentSession, getPlaces, googlePhoto, googlePlaces, setPlace, type PlaceKind, type Places } from './sync';
import { ICON } from './icons';
import { getMeta, setMeta, type FuelLog } from './db';

export interface CarInfo { model: CarModel; name: string }
interface Ctx {
  $: <T extends HTMLElement = HTMLElement>(id: string) => T;
  fmt: (n: number, d?: number) => string;
  brl: (n: number) => string;
  esc: (s: unknown) => string;
  toast: (m: string) => void;
  openSheet: (id: string) => void;
  closeSheets: () => void;
  show: (view: string) => void;
  todayISO: () => string;
  car: () => CarInfo;
  own: () => OwnPrice[];
  logsAt: (cnpj: string) => FuelLog[];
  places: () => Places;
  fillAt: (s: Station, fuel: Fuel, price: number | null) => void;
  /** Postos que você usa (com CNPJ), do mais frequente para o menos, com o rendimento dos tanques. */
  usage: () => StationUse[];
  /** Abastecimentos do carro atual sem posto anotado. */
  unlinked: () => number;
  /** Liga esses abastecimentos a um posto; devolve quantos mudaram. */
  linkFills: (s: Station) => Promise<number>;
}

/**
 * Abre o posto no Google Maps (nota, fotos e o botão de rotas ficam lá).
 * Com o lugar do Google já identificado, abre exatamente ele; senão, pelo endereço
 * (o nome do cadastro da ANP é a razão social e costuma não bater com o do Maps).
 */
export function mapsUrl(s: Station, g?: GoogleMatch) {
  if (g) return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(g.name) + '&query_place_id=' + encodeURIComponent(g.id);
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(['Posto', s.e, s.m, 'SC'].filter(Boolean).join(', '));
}

/** Texto do campo "Posto" no abastecimento: nome e endereço (dois postos podem ter o mesmo nome). */
export function stationLabel(s: Station) {
  return (s.n + ' · ' + s.e).slice(0, 80);
}

type BaseKind = 'agora' | 'casa' | 'trabalho' | 'rota' | 'busca';
const BASE_LABEL: Record<Exclude<BaseKind, 'busca'>, string> = { agora: 'Agora', casa: 'Casa', trabalho: 'Trabalho', rota: 'Caminho' };
const REC_LABEL: Record<BaseKind, string> = {
  agora: 'Melhor opção perto de você', casa: 'Melhor opção perto de casa', trabalho: 'Melhor opção perto do trabalho',
  rota: 'Melhor opção no seu caminho', busca: 'Melhor opção perto do local escolhido',
};
const FUEL: Record<Fuel, string> = { gasolina: 'Gasolina', etanol: 'Etanol' };
const RADII = [2, 5, 10];
const DETOURS = [500, 1000, 2000];
const PIN = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
const TARGET = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/></svg>';
const HOUSE = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>';
const BAG = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/></svg>';

export function initPostos(ctx: Ctx) {
  const { $, fmt, brl, esc } = ctx;
  const kmTxt = (d: number) => (d < 0.95 ? Math.round(d * 10) * 100 + ' m' : fmt(d, 1) + ' km');
  const dm = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7);

  let file: StationsFile | null = null;
  let loadFailed = false;
  let base: BaseKind = 'agora';
  let radius = 5;
  let here: { p: LatLon; at: number } | null = null;
  let locating = false;
  let other: FoundPlace | null = null;
  let showAll = false;
  let from = 'inicio';
  /** Lugares do Google ligados aos postos da ANP (nome, nota, id), só durante o uso do app. */
  const gmatch = new Map<string, GoogleMatch>();
  const google = new Map<string, { rating: number; count: number }>();
  const gTried = new Set<string>();
  const nm = (s: Station) => gmatch.get(s.c)?.name || s.n;
  /** Postos com o ponto do Google quando já identificados (mais preciso que o endereço geocodificado). */
  let adjusted: Station[] | null = null;
  function stations(): Station[] {
    if (!file) return [];
    if (!gmatch.size) return file.postos;
    if (!adjusted) adjusted = file.postos.map((s) => { const g = gmatch.get(s.c); return g ? { ...s, la: g.lat, lo: g.lon, pg: 'n' as const } : s; });
    return adjusted;
  }
  function addMatches(m: Map<string, GoogleMatch>) {
    if (m.size) adjusted = null;
    for (const [c, g] of m) {
      gmatch.set(c, g);
      if (g.rating != null) google.set(c, { rating: g.rating, count: g.count });
    }
  }
  const googleDone = new Set<string>();
  let googleOn: boolean | null = null;

  async function ensureFile() {
    if (file) return file;
    file = await loadStations();
    loadFailed = !file;
    return file;
  }

  /* ---------- base de busca ---------- */
  function rota(pl: Places = ctx.places()): (Route & { on: boolean; detour_m: number }) | null {
    const r = pl.rota;
    if (!r || r.deleted_at) return null;
    const d = r.data as Partial<Route & { on: boolean; detour_m: number }>;
    return { pts: d.pts ?? [], km: d.km ?? 0, min: d.min ?? 0, from: d.from ?? [0, 0], to: d.to ?? [0, 0], roads: d.roads, on: !!d.on, detour_m: d.detour_m ?? 1000 };
  }
  function place(kind: 'casa' | 'trabalho', pl: Places = ctx.places()) {
    const p = pl[kind];
    return p && !p.deleted_at && p.lat != null && p.lon != null ? { lat: p.lat, lon: p.lon, label: p.label ?? '' } : null;
  }

  type Resolved = { base: Base; where: string; center: LatLon } | { need: 'gps' | 'casa' | 'trabalho' | 'rota'; where: string };
  function resolve(kind: BaseKind): Resolved {
    if (kind === 'agora') {
      if (!here) return { need: 'gps', where: 'Onde você está agora' };
      return { base: { kind: 'ponto', at: here.p, radiusKm: radius }, where: 'Onde você está agora (GPS)', center: here.p };
    }
    if (kind === 'casa' || kind === 'trabalho') {
      const p = place(kind);
      if (!p) return { need: kind, where: kind === 'casa' ? 'Casa não cadastrada' : 'Trabalho não cadastrado' };
      return { base: { kind: 'ponto', at: p, radiusKm: radius }, where: (kind === 'casa' ? 'Casa · ' : 'Trabalho · ') + p.label, center: p };
    }
    if (kind === 'busca') {
      if (!other) return { need: 'gps', where: 'Escolha um local' };
      return { base: { kind: 'ponto', at: other, radiusKm: radius }, where: other.label, center: other };
    }
    const r = rota();
    if (!r || !r.on || r.pts.length < 2) return { need: 'rota', where: 'No caminho casa → trabalho' };
    const path = r.pts.map(([lat, lon]) => ({ lat, lon }));
    return { base: { kind: 'rota', path, detourKm: r.detour_m / 1000, roads: r.roads }, where: 'No caminho casa → trabalho · ' + fmt(r.km, 1) + ' km', center: path[Math.floor(path.length / 2)] };
  }

  function compute(b: Base): { rows: StationRow[]; rec: Recommendation } {
    const rows = stationsFor(stations(), b, ctx.car().model, ctx.own(), ctx.todayISO(), google);
    return { rows, rec: recommend(rows) };
  }

  /* ---------- notas do Google (quando configuradas) ---------- */
  /* Cache do Google no aparelho: cada área (e cada posto procurado) é buscada no máximo uma vez por semana. */
  const G_TTL = 7 * 86400000;
  const G_KEY = 'google_cache_v2'; // v2: resultados com foto
  type GCache = Record<string, { at: number; places: GoogleStation[] }>;
  let gcache: GCache | null = null;
  let gBlocked = '';
  async function gGet(key: string): Promise<GoogleStation[] | null> {
    gcache ??= await getMeta<GCache>(G_KEY, {});
    const e = gcache[key];
    return e && Date.now() - e.at < G_TTL ? e.places : null;
  }
  async function gPut(key: string, places: GoogleStation[]) {
    gcache ??= await getMeta<GCache>(G_KEY, {});
    gcache[key] = { at: Date.now(), places };
    const keys = Object.keys(gcache).filter((k) => Date.now() - gcache![k].at < G_TTL).sort((a, b) => gcache![b].at - gcache![a].at);
    gcache = Object.fromEntries(keys.slice(0, 80).map((k) => [k, gcache![k]]));
    await setMeta(G_KEY, gcache);
  }
  /** Erro da função: 429 = limite do dia (do app ou da conta); para de tentar até reabrir o app. */
  async function gError(e: unknown) {
    const ctxRes = (e as { context?: Response })?.context;
    if (ctxRes?.status === 429) {
      try { gBlocked = (await ctxRes.json()).error; } catch { gBlocked = 'Limite diário do Google atingido.'; }
      render();
    } else console.warn('google', e);
  }

  async function fetchGoogle(center: LatLon, radiusKm: number) {
    if (googleOn === false || gBlocked || !file) return;
    // área arredondada (~2 km) e raio em degraus: abrir de novo no mesmo lugar reaproveita a busca
    const snap = { lat: Math.round(center.lat / 0.02) * 0.02, lon: Math.round(center.lon / 0.02) * 0.02 };
    const r = radiusKm <= 4 ? 4 : radiusKm <= 7 ? 7 : 10;
    const key = 'nearby:' + snap.lat.toFixed(2) + ',' + snap.lon.toFixed(2) + ',' + r;
    if (googleDone.has(key)) return;
    googleDone.add(key);
    let places = await gGet(key);
    if (places) googleOn = true;
    else {
      if (navigator.onLine === false || !(await currentSession())) return;
      try {
        const res = await googlePlaces<GoogleStation>({ mode: 'nearby', lat: snap.lat, lon: snap.lon, radius_m: Math.round((r * 1000) / 1.3) });
        googleOn = res.configured;
        if (!res.configured) return;
        places = res.places;
        await gPut(key, places);
      } catch (e) {
        return gError(e);
      }
    }
    const bb = bboxAround(snap, r + 3);
    const near = file.postos.filter((s) => s.la > bb.s && s.la < bb.n && s.lo > bb.w && s.lo < bb.e && !gmatch.has(s.c));
    addMatches(matchGoogle(places, near));
    render();
    renderHome();
  }

  /* ---------- aba Postos ---------- */
  async function open(kind?: BaseKind, origin?: string) {
    if (rota()?.on && !rota()?.roads) refreshRoute(); // caminhos salvos antes de guardarmos os nomes das ruas
    from = origin ?? (document.querySelector('.tab[aria-selected="true"]') as HTMLElement | null)?.dataset.view ?? 'inicio';
    $('p-back-label').textContent = from === 'mais' ? 'Mais' : 'Início';
    if (kind) base = kind;
    else base = rota()?.on ? 'rota' : place('casa') ? 'casa' : 'agora';
    showAll = false;
    ctx.show('postos');
    render();
    await ensureFile();
    if (base === 'agora' && !here) locate();
    else render();
  }

  async function locate() {
    if (locating) return;
    locating = true;
    render();
    try {
      here = { p: await gps(), at: Date.now() };
      base = 'agora';
    } catch (e) {
      ctx.toast((e as Error).message);
    } finally {
      locating = false;
      render();
    }
  }

  function chipScore(r: StationRow) {
    const t = r.rel.level === 'ok' ? 'confiável' : r.rel.level === 'atencao' ? 'atenção' : r.rel.recentSerious ? 'ocorrência recente' : 'evitar';
    return '<span class="score ' + r.rel.level + '">' + fmt(r.rel.score, 1) + ' ' + t + '</span>';
  }
  function src(pp: { src: string; date: string } | null, today: string) {
    if (!pp) return '<span class="src none">sem preço recente</span>';
    const old = ageDays(pp.date, today) > 30;
    return '<span class="src' + (pp.src === 'voce' ? ' mine' : '') + (old ? ' old' : '') + '">' + (pp.src === 'voce' ? 'você pagou' : 'ANP') + ' · ' + dm(pp.date) + '</span>';
  }
  function priceTxt(pp: { price: number } | null) {
    return pp ? brl(pp.price) : '–';
  }
  function distTxt(r: StationRow, b: Base) {
    if (b.kind === 'rota') return r.distKm < 0.15 ? 'no caminho' : '+' + kmTxt(r.extraKm) + ' de desvio';
    return '≈ ' + kmTxt(r.distKm);
  }

  function recCard(kind: BaseKind, rec: Recommendation, b: Base) {
    const car = ctx.car();
    const best = rec.best!;
    const dist = b.kind === 'rota' ? (best.distKm < 0.15 ? 'no caminho' : '+' + kmTxt(best.extraKm) + ' de desvio') : kmTxt(best.distKm);
    let save = '';
    if (rec.bestOther) {
      const diff = rec.bestOther.cost - best.cost;
      save = '<div class="rec-tiles"><div><span>Custo por km</span><b>' + brl(best.costPerKm) + '</b></div><div><span>vs. ' + FUEL[rec.bestOther.fuel].toLowerCase() + ' mais em conta</span><b class="up">−' + brl(diff) + '</b></div></div>';
    } else {
      save = '<div class="rec-tiles"><div><span>Custo por km</span><b>' + brl(best.costPerKm) + '</b></div><div><span>Para rodar ' + Math.round(car.model.kmTank) + ' km</span><b>' + brl(best.cost) + '</b></div></div>';
    }
    const ratio = car.model.fuels.length > 1
      ? 'Etanol rende ' + Math.round((car.model.kmlE / car.model.kmlG) * 100) + '% da gasolina no ' + esc(car.name) + (car.model.measured ? ' (medido)' : ' (estimado)') + ' · conta ida e volta'
      : 'Conta ida e volta até o posto';
    const warn = rec.cheaperUnsafe
      ? '<p class="rec-warn">' + ICON.warn + '<span>' + esc(nm(rec.cheaperUnsafe.s)) + ' sairia mais barato, mas ficou de fora: ' + (rec.cheaperUnsafe.rel.recentSerious ? 'teve autuação séria da ANP nos últimos 12 meses.' : 'confiabilidade baixa.') + '</span></p>'
      : '';
    return (
      '<button type="button" class="rec-card" data-posto="' + best.s.c + '"><span class="l">' + REC_LABEL[kind] + '</span>' +
      '<span class="t">' + FUEL[best.fuel] + ' no ' + esc(nm(best.s)) + '</span>' +
      '<span class="s">' + brl(best.price.price) + '/l · ' + dist + ' · confiabilidade ' + fmt(best.rel.score, 1) + '</span>' + save +
      '<span class="f">' + ratio + '</span></button>' + warn
    );
  }

  function compareCard(kind: BaseKind) {
    const opts: [BaseKind, string][] = [];
    if (place('casa')) opts.push(['casa', 'Casa']);
    if (place('trabalho')) opts.push(['trabalho', 'Trabalho']);
    const r = rota();
    if (r?.on && r.pts.length > 1) opts.push(['rota', 'No caminho']);
    if (opts.length < 2) return '';
    const res = opts.map(([k, label]) => {
      const rs = resolve(k);
      const best = 'base' in rs ? compute(rs.base).rec.best : null;
      return { k, label, best };
    });
    const valid = res.filter((x) => x.best);
    if (valid.length < 2) return '';
    const min = Math.min(...valid.map((x) => x.best!.cost));
    return (
      '<div class="card cmp"><span class="hint b">Para rodar ' + Math.round(ctx.car().model.kmTank) + ' km no melhor posto de cada lugar</span><div class="cmp-grid">' +
      res.map((x) => {
        if (!x.best) return '<button type="button" class="cmp-cell" data-base="' + x.k + '"><span>' + x.label + '</span><b>–</b><em>sem preço</em></button>';
        const cheapest = x.best.cost === min;
        return '<button type="button" class="cmp-cell' + (cheapest ? ' win' : '') + (x.k === kind ? ' cur' : '') + '" data-base="' + x.k + '"><span>' + x.label + '</span><b>' + brl(x.best.cost) + '</b><em>' + (cheapest ? 'mais barato' : '+' + brl(x.best.cost - min)) + '</em></button>';
      }).join('') + '</div></div>'
    );
  }

  function needCard(need: string) {
    if (need === 'gps')
      return '<div class="card center"><p class="hint">' + (locating ? 'Pegando sua localização…' : 'Use a localização do celular ou escolha um endereço.') + '</p><div class="btn-row"><button type="button" class="btn primary" data-act="gps"' + (locating ? ' disabled' : '') + '>' + TARGET + 'Minha localização</button><button type="button" class="btn" data-act="outro">Outro local</button></div></div>';
    const txt = need === 'rota'
      ? 'Cadastre casa e trabalho e ligue “Postos no caminho” para ver os postos do seu trajeto.'
      : 'Cadastre ' + (need === 'casa' ? 'o endereço de casa' : 'o endereço do trabalho') + ' para comparar os postos de lá.';
    return '<div class="card center"><p class="hint">' + txt + '</p><button type="button" class="btn primary" data-act="locais">Cadastrar casa e trabalho</button></div>';
  }

  function stationRow(r: StationRow, b: Base, today: string) {
    const sub = [distTxt(r, b), r.s.e, r.s.b].filter(Boolean).map(esc).join(' · ');
    const mineTag = favorite()?.s.c === r.s.c ? '<span class="tag mine">seu posto</span> ' : '';
    const p = r.best?.price ?? r.gas ?? r.eth;
    const any = !!(r.gas || r.eth);
    const gasOn = any && ctx.car().model.fuels.includes('gasolina'), ethOn = any && ctx.car().model.fuels.includes('etanol');
    return (
      '<button type="button" class="st-row" data-posto="' + r.s.c + '"><span class="h"><span class="n"><span>' + mineTag + esc(nm(r.s)) + '</span><span>' + sub + '</span></span>' + chipScore(r) + '</span>' +
      '<span class="p">' + (gasOn ? '<span><i class="dot gas"></i>' + priceTxt(r.gas) + '</span>' : '') + (ethOn ? '<span><i class="dot eth"></i>' + priceTxt(r.eth) + '</span>' : '') + src(p, today) + '</span></button>'
    );
  }

  /** Seu posto mais usado que está na lista da ANP. */
  function favorite(): { u: StationUse; s: Station } | null {
    if (!file) return null;
    for (const u of ctx.usage()) {
      const s = stations().find((x) => x.c === u.station_id);
      if (s) return { u, s };
    }
    return null;
  }

  /** O mesmo posto calculado a partir da base atual (sem limite de raio). */
  function rowFor(s: Station, b: Base): StationRow {
    return stationsFor([s], b.kind === 'ponto' ? { ...b, radiusKm: 9999 } : { ...b, detourKm: 9999 }, ctx.car().model, ctx.own(), ctx.todayISO(), google)[0];
  }

  function myCard(b: Base, rec: Recommendation) {
    const fav = favorite();
    if (!fav) return '';
    const { u, s } = fav;
    const row = rowFor(s, b);
    const km = Math.round(ctx.car().model.kmTank);
    let price = '';
    const mine = row.best && !row.best.stale ? row.best : null;
    if (!mine) price = 'Sem preço recente deste posto. Ao abastecer lá, o preço que você pagar passa a valer.';
    else if (!rec.best) price = FUEL[mine.fuel] + ' a ' + brl(mine.price.price) + ' (' + (mine.price.src === 'voce' ? 'você pagou' : 'ANP') + ', ' + dm(mine.price.date) + ') · ' + distTxt(row, b) + ' daqui.';
    else if (rec.best && rec.best.s.c === s.c) price = '<b>É a melhor opção agora</b> (' + FUEL[mine.fuel].toLowerCase() + ' a ' + brl(mine.price.price) + ').';
    else if (rec.best) {
      const diff = mine.cost - rec.best.cost;
      price = diff > 0.5
        ? FUEL[mine.fuel] + ' a ' + brl(mine.price.price) + ': para rodar ' + km + ' km sai <b>≈ ' + brl(diff) + ' mais caro</b> que a melhor opção (' + esc(nm(rec.best.s)) + ').'
        : FUEL[mine.fuel] + ' a ' + brl(mine.price.price) + ': praticamente o mesmo custo da melhor opção.';
    }
    const v = usageVerdict(u);
    return (
      '<button type="button" class="card my-card" data-posto="' + s.c + '"><span class="l">Seu posto · ' + u.fills + (u.fills === 1 ? ' abastecimento' : ' abastecimentos') + ', o último em ' + dm(u.last) + '</span>' +
      '<span class="t">' + esc(nm(s)) + '</span>' +
      '<span class="s">' + price + '</span>' +
      (v ? '<span class="s ' + v.tone + '">' + esc(v.text) + '</span>' : '') + '</button>'
    );
  }

  function noPriceCard(rows: StationRow[], b: Base) {
    const r = bestWithoutPrice(rows);
    const head = '<span class="l">Nenhum posto ' + (b.kind === 'rota' ? 'no caminho' : 'neste raio') + ' tem preço recente</span>';
    if (!r) return '<div class="card my-card">' + head + '<span class="s">Os postos daqui não têm preço na pesquisa da ANP e nenhum passou na confiabilidade.</span></div>';
    return (
      '<button type="button" class="card my-card" data-posto="' + r.s.c + '">' + head +
      '<span class="t">Melhor avaliado e mais perto: ' + esc(nm(r.s)) + '</span>' +
      '<span class="s">Confiabilidade ' + fmt(r.rel.score, 1) + ' · ' + distTxt(r, b) + ' · <b>sem preço</b>: confira na bomba. O preço que você pagar fica registrado para as próximas vezes.</span></button>'
    );
  }

  function render() {
    if ($('v-postos').hidden) return;
    const today = ctx.todayISO();
    document.querySelectorAll<HTMLElement>('#p-base button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.base === base)));
    const rs = resolve(base);
    const where = $('p-where');
    const right = 'base' in rs && rs.base.kind === 'rota'
      ? '<span class="mini-seg" id="p-detour">' + DETOURS.map((d) => '<button type="button" data-detour="' + d + '" aria-pressed="' + (rota()?.detour_m === d) + '">' + (d < 1000 ? d + ' m' : d / 1000 + ' km') + '</button>').join('') + '</span>'
      : '<span class="mini-seg" id="p-radius">' + RADII.map((r) => '<button type="button" data-radius="' + r + '" aria-pressed="' + (radius === r) + '">' + r + ' km</button>').join('') + '</span>';
    where.innerHTML = '<span class="w">' + PIN + '<span>' + esc(rs.where) + '</span></span>' + right;
    const body = $('p-body');
    if (!file) {
      body.innerHTML = loadFailed
        ? '<div class="card center"><p class="hint">Não consegui carregar a lista de postos. Na primeira vez é preciso internet; depois ela fica no celular.</p><button type="button" class="btn" data-act="retry">Tentar de novo</button></div>'
        : '<div class="empty">Carregando postos…</div>';
      return;
    }
    if ('need' in rs) {
      body.innerHTML = needCard(rs.need) + compareCard(base) + sourcesNote();
      return;
    }
    const { rows, rec } = compute(rs.base);
    if (rs.base.kind === 'ponto') fetchGoogle(rs.center, radius);
    else {
      const path = rs.base.path;
      // um ponto a cada ~7 km do caminho, raio de 4 km (o Google devolve no máximo 20 postos por busca)
      let acc = 0;
      fetchGoogle(path[0], 4);
      for (let i = 1; i < path.length; i++) {
        acc += haversineKm(path[i - 1], path[i]);
        if (acc >= 7 || i === path.length - 1) { fetchGoogle(path[i], 4); acc = 0; }
      }
    }
    const sorted = sortRows(rows);
    const limit = showAll ? sorted.length : 20;
    let html = '';
    if (rec.best) html += recCard(base, rec, rs.base);
    else if (rows.length) html += noPriceCard(rows, rs.base);
    html += myCard(rs.base, rec);
    html += compareCard(base);
    if (!rows.length) {
      html += '<div class="card center"><p class="hint">Nenhum posto ' + (rs.base.kind === 'rota' ? 'tão perto do caminho' : 'neste raio') + '. Aumente a distância acima.</p></div>';
    } else {
      html += '<div class="sec-head"><span>' + rows.length + (rows.length === 1 ? ' posto' : ' postos') + '</span><span class="hint">preço mais recente primeiro</span></div>';
      html += '<div class="list-card">' + sorted.slice(0, limit).map((r) => stationRow(r, rs.base, today)).join('') + (sorted.length > limit ? '<button type="button" class="list-more" data-act="all">Mostrar todos (' + sorted.length + ')</button>' : '') + '</div>';
    }
    body.innerHTML = html + sourcesNote();
  }

  function sourcesNote() {
    if (!file) return '';
    const w = file.fontes.lpc_semanas[0];
    const g = gBlocked ? esc(gBlocked) + ' As notas já buscadas continuam valendo.' : googleOn === true ? 'Notas do Google incluídas (atualizadas uma vez por semana).' : googleOn === false ? 'Notas do Google ainda não configuradas; a nota usa só a fiscalização.' : '';
    return '<p class="foot-note">Preços: pesquisa semanal da ANP' + (w ? ' (mais recente: ' + dm(w[0]) + ' a ' + dm(w[1]) + ')' : '') + ' e os seus abastecimentos. Confiabilidade: fiscalização da ANP nos últimos 5 anos' + (file.fontes.fisc_ate ? ' (até ' + dm(file.fontes.fisc_ate) + '/' + file.fontes.fisc_ate.slice(0, 4) + ')' : '') + '. ' + g + ' Distâncias aproximadas.</p>';
  }

  $('p-base').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-base]');
    if (!b) return;
    base = b.dataset.base as BaseKind;
    showAll = false;
    if (base === 'agora' && !here) return locate();
    render();
  });
  $('p-where').addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    const r = el.closest<HTMLElement>('[data-radius]');
    const d = el.closest<HTMLElement>('[data-detour]');
    if (r) { radius = Number(r.dataset.radius); render(); }
    if (d) {
      const cur = rota();
      if (cur) await setPlace('rota', { label: 'Casa → Trabalho', lat: null, lon: null, data: { ...ctx.places().rota!.data, detour_m: Number(d.dataset.detour) } });
    }
  });
  $('v-postos').addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const act = el.closest<HTMLElement>('[data-act]')?.dataset.act;
    const posto = el.closest<HTMLElement>('[data-posto]')?.dataset.posto;
    const cmp = el.closest<HTMLElement>('.cmp-cell[data-base]')?.dataset.base;
    if (act === 'gps') return locate();
    if (act === 'outro') return openLocal();
    if (act === 'locais') return openLocais();
    if (act === 'all') { showAll = true; return render(); }
    if (act === 'retry') { loadFailed = false; render(); ensureFile().then(render); return; }
    if (cmp) { base = cmp as BaseKind; return render(); }
    if (posto) openPosto(posto);
  });
  $('p-back').addEventListener('click', () => ctx.show(from));
  $('p-outro').addEventListener('click', () => openLocal());

  /* ---------- ficha do posto ---------- */
  let shown: Station | null = null;
  function openPosto(cnpj: string) {
    const s = stations().find((x) => x.c === cnpj);
    if (!s) return;
    shown = s;
    const today = ctx.todayISO();
    const rs = resolve(base);
    const b: Base = 'base' in rs ? rs.base : { kind: 'ponto', at: { lat: s.la, lon: s.lo }, radiusKm: 999 };
    const row = stationsFor([s], b.kind === 'ponto' ? { ...b, radiusKm: 999 } : { ...b, detourKm: 999 }, ctx.car().model, ctx.own(), today, google)[0];
    const car = ctx.car().model;
    const rel = row.rel;
    const priceCell = (fuel: Fuel, pp: StationRow['gas']) =>
      '<div class="pc"><span class="k"><i class="dot ' + (fuel === 'gasolina' ? 'gas' : 'eth') + '"></i>' + FUEL[fuel] + '</span><span class="v">' + (pp ? brl(pp.price) : '–') + '</span><span class="d">' + (pp ? (pp.src === 'voce' ? 'você pagou em ' : 'ANP, pesquisa de ') + dm(pp.date) + (ageDays(pp.date, today) > 30 ? ' (antigo)' : '') : 'sem preço recente') + '</span></div>';
    const extra = (['ga', 'd10', 'ds', 'gnv'] as const).filter((k) => s.pr?.[k]).map((k) => ({ ga: 'Gasolina aditivada', d10: 'Diesel S10', ds: 'Diesel', gnv: 'GNV' })[k] + ' ' + brl(s.pr![k]![0])).join(' · ');
    const costs = row.opts.map((o: Option) => FUEL[o.fuel].toLowerCase() + ' ≈ <b>' + brl(o.cost) + '</b>').join(' · ');
    const lvl = rel.level === 'ok' ? 'Confiável' : rel.level === 'atencao' ? 'Atenção' : 'Evitar';
    const ev = (s.f?.ev ?? []).filter(([d]) => ageDays(d, today) <= 5 * 366);
    const anpTxt = s.f
      ? s.f.n + (s.f.n === 1 ? ' fiscalização' : ' fiscalizações') + ' em 5 anos · ' + (rel.infractions ? rel.infractions + (rel.infractions === 1 ? ' infração' : ' infrações') : 'nenhuma infração') + (rel.interdictions ? ' · ' + rel.interdictions + (rel.interdictions === 1 ? ' interdição ou apreensão' : ' interdições ou apreensões') : '')
      : 'Sem fiscalização registrada nos últimos 5 anos (nota neutra)';
    const g = google.get(s.c);
    const gm = gmatch.get(s.c);
    if (!gm && googleOn !== false && !gTried.has(s.c)) lookupStation(s);
    const mine = ctx.logsAt(s.c);
    const dist = 'base' in rs ? (b.kind === 'rota' ? (row.distKm < 0.15 ? 'no caminho' : '+' + kmTxt(row.extraKm) + ' de desvio') : kmTxt(row.distKm)) : '';
    $('posto-title').textContent = nm(s);
    $('posto-body').innerHTML =
      (gm?.photo ? '<figure class="ps-photo" id="ps-photo"><div class="ph"></div><figcaption>Foto: ' + esc(gm.photo.author || 'Google') + ' · Google</figcaption></figure>' : '') +
      '<div class="ps-head"><h2>' + esc(nm(s)) + '</h2>' + (gm && gm.name !== s.n ? '<span class="hint">No cadastro da ANP: ' + esc(s.n) + '</span>' : '') + '<span class="hint">' + [s.e, s.br, s.m].filter(Boolean).map(esc).join(', ') + '</span><span class="hint">' + [dist, s.b].filter(Boolean).map(esc).join(' · ') + (s.pg === 'b' ? ' · localização aproximada (bairro)' : '') + '</span></div>' +
      '<div class="price-grid">' + (car.fuels.includes('gasolina') ? priceCell('gasolina', row.gas) : '') + (car.fuels.includes('etanol') ? priceCell('etanol', row.eth) : '') + '</div>' +
      (extra ? '<p class="hint">Também: ' + esc(extra) + '</p>' : '') +
      (costs ? '<p class="hint">Para rodar ' + Math.round(car.kmTank) + ' km: ' + costs + (b.kind === 'rota' || 'base' in rs ? ' (com a ida e volta)' : '') + '</p>' : '') +
      '<div class="card rel"><div class="card-head"><span>Confiabilidade</span><span class="hint">de 0 a 5</span></div>' +
      '<div class="rel-score"><b>' + fmt(rel.score, 1) + '</b><span class="score ' + rel.level + '">' + lvl + '</span></div>' +
      '<div class="rel-part"><div class="h"><span>Fiscalização da ANP (5 anos)</span><b>' + fmt(rel.anp, 1) + '</b></div><div class="bar"><i style="width:' + Math.round((rel.anp / 5) * 100) + '%"></i></div><span class="hint">' + esc(anpTxt) + '</span></div>' +
      (ev.length ? '<ul class="ev-list">' + ev.slice(0, 6).map(([d, t, txt]) => '<li><span class="d">' + dm(d) + '/' + d.slice(2, 4) + '</span><span><b>' + EVENT_LABEL[t] + '</b>' + (txt ? ' · ' + esc(txt.replace(/^(Notificação|MRC)\s*-\s*(PR ?Comb\s*-\s*)?/i, '')) : '') + '</span></li>').join('') + '</ul>' : '') +
      '<div class="rel-part"><div class="h"><span>Avaliações no Google</span><b>' + (g ? fmt(g.rating, 1) : '–') + '</b></div>' +
      (g ? '<div class="bar"><i style="width:' + Math.round((g.rating / 5) * 100) + '%"></i></div><span class="hint">' + fmt(g.rating, 1) + ' em ' + g.count.toLocaleString('pt-BR') + ' avaliações</span>' : '<span class="hint">' + (gBlocked ? esc(gBlocked) : googleOn ? (gTried.has(s.c) && !gm ? 'Não encontrei este posto no Google.' : 'Procurando no Google…') : googleOn === false ? 'Ainda não configurado: a nota usa só a fiscalização.' : 'Disponível com a conta conectada.') + '</span>') + '</div>' +
      '<details class="more"><summary>Como a nota é calculada<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg></summary><p class="hint">Começa em 5 e cada ocorrência da ANP nos últimos 5 anos desconta, mais quanto mais recente e mais grave: interdição e apreensão pesam mais; infração ligada ao combustível pesa mais que infração de papelada; notificação e medida corretiva pesam pouco. Infração de aferição da bomba, volume ou qualidade do combustível nos últimos 12 meses limita a nota em 2,5 e tira o posto da recomendação. Com o Google ligado, a média das avaliações entra com peso de 35%, puxada para 4,0 quando há poucas avaliações.</p></details></div>' +
      '<div class="card"><div class="card-head"><span>Como chegar</span><span class="hint" id="ps-eta"></span></div><div class="ps-map" id="ps-map" role="img" aria-label="Mapa com o posto e o caminho até ele"></div><span class="hint" id="ps-map-note"></span></div>' +
      '<div class="card"><span class="b15">Seus abastecimentos aqui</span>' +
      (() => {
        const u = ctx.usage().find((x) => x.station_id === s.c);
        const v = u ? usageVerdict(u) : null;
        return v ? '<span class="hint ' + v.tone + '">' + esc(v.text) + (u!.kml ? ' Média daqui: ' + fmt(u!.kml, 2) + ' km/l.' : '') + '</span>' : '';
      })() +
      (() => {
        const n = ctx.unlinked();
        return n ? '<button type="button" class="btn sm" id="posto-mine" data-armed="0">É aqui que eu abasteço</button><span class="hint">Liga a este posto ' + (n === 1 ? 'o seu abastecimento' : 'os seus ' + n + ' abastecimentos') + ' sem posto anotado; o último preço que você pagou passa a valer para ele.</span>' : '';
      })() +
      (mine.length ? '<ul class="ev-list">' + mine.slice(0, 5).map((f) => '<li><span class="d">' + dm(f.date) + '/' + f.date.slice(2, 4) + '</span><span>' + FUEL[f.fuel as Fuel] + ' · ' + brl(f.price_per_l) + '/l · ' + brl(f.total_brl) + '</span></li>').join('') + '</ul>' : '<span class="hint">Nenhum ainda. Abastecendo por aqui, o preço que você pagar passa a valer como o dado mais recente deste posto.</span>') + '</div>';
    ctx.openSheet('posto-sheet');
    if (gm?.photo) showPhoto(gm.photo);
    setTimeout(() => showMap(s), 280); // depois da animação da folha, para o mapa saber o próprio tamanho
  }
  /* ---------- foto e mapa da ficha ---------- */
  const photoUris = new Map<string, string | null>();
  async function showPhoto(ph: { name: string }) {
    let uri = photoUris.get(ph.name);
    if (uri === undefined && !gBlocked) {
      try {
        uri = await googlePhoto(ph.name);
      } catch (e) {
        await gError(e);
        uri = null;
      }
      photoUris.set(ph.name, uri ?? null);
    }
    const fig = document.getElementById('ps-photo');
    if (!fig) return;
    if (!uri) return fig.remove();
    const img = new Image();
    img.alt = 'Foto do posto';
    img.decoding = 'async';
    img.onload = () => fig.querySelector('.ph')?.replaceWith(img);
    img.onerror = () => fig.remove();
    img.src = uri;
  }

  let leaflet: typeof import('leaflet') | null = null;
  let map: import('leaflet').Map | null = null;
  const routes = new Map<string, { pts: [number, number][]; km: number; min: number } | null>();
  async function showMap(s: Station) {
    const el = document.getElementById('ps-map');
    if (!el || shown?.c !== s.c) return;
    if (!leaflet) {
      [leaflet] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]);
    }
    const L = leaflet;
    map?.remove();
    // sem animações: a ficha pode fechar ou trocar de posto no meio de uma, e o Leaflet quebra
    map = L.map(el, { zoomControl: false, attributionControl: true, scrollWheelZoom: false, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false });
    map.attributionControl.setPrefix(false);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    const dest: [number, number] = [s.la, s.lo];
    L.circleMarker(dest, { radius: 9, color: '#FFFFFF', weight: 3, fillColor: '#C2410C', fillOpacity: 1 }).addTo(map).bindTooltip(nm(s), { direction: 'top', offset: [0, -8] });
    // Origem: GPS recente; senão, o lugar de onde você está buscando (casa, trabalho ou o local escolhido)
    const fresh = here && Date.now() - here.at < 15 * 60000 ? here.p : null;
    const rs = resolve(base);
    const fromBase = base === 'rota' ? place('casa') : 'center' in rs ? rs.center : null;
    const origin = fresh ?? fromBase;
    const label = fresh ? 'de onde você está' : base === 'casa' || base === 'rota' ? 'de casa' : base === 'trabalho' ? 'do trabalho' : 'do local escolhido';
    const eta = document.getElementById('ps-eta')!, note = document.getElementById('ps-map-note')!;
    if (!origin) {
      map.setView(dest, 15);
      note.innerHTML = 'Use <b>Agora</b> na aba Postos para ver o caminho a partir de onde você está.';
      return;
    }
    const o: [number, number] = [origin.lat, origin.lon];
    L.circleMarker(o, { radius: 7, color: '#FFFFFF', weight: 3, fillColor: '#1D4ED8', fillOpacity: 1 }).addTo(map);
    map.fitBounds(L.latLngBounds([o, dest]).pad(0.25));
    const key = o.map((x) => x.toFixed(4)).join(',') + '>' + s.c;
    let r = routes.get(key);
    if (r === undefined) {
      eta.textContent = 'calculando…';
      try {
        r = await route(origin, { lat: s.la, lon: s.lo });
      } catch {
        r = null;
      }
      routes.set(key, r);
    }
    if (!map || shown?.c !== s.c) return;
    if (!r) {
      eta.textContent = '';
      note.textContent = navigator.onLine === false ? 'Sem internet para calcular o caminho.' : 'Não consegui calcular o caminho agora.';
      return;
    }
    const line = L.polyline(r.pts, { color: '#1D4ED8', weight: 5, opacity: 0.85 }).addTo(map);
    map.fitBounds(line.getBounds().extend(dest).extend(o).pad(0.15));
    eta.textContent = '≈ ' + (r.min < 1 ? '1' : r.min) + ' min · ' + fmt(r.km, 1) + ' km';
    note.textContent = 'De carro, ' + label + ', sem contar trânsito. Para navegar, toque em Abrir no Maps.';
  }

  /** Busca pontual de um posto que a busca por perto não trouxe (o Google devolve no máximo 20 por área). */
  async function lookupStation(s: Station) {
    gTried.add(s.c);
    const key = 'posto:' + s.c;
    let places = await gGet(key);
    if (!places && !gBlocked) {
      try {
        const res = await googlePlaces<GoogleStation>({ mode: 'posto', query: 'posto de combustível ' + s.e + ', ' + s.m + ' SC', lat: s.la, lon: s.lo });
        googleOn = res.configured;
        if (res.configured) {
          places = res.places;
          await gPut(key, places);
        }
      } catch (e) {
        await gError(e);
      }
    }
    if (places) addMatches(matchGoogle(places, [s]));
    if (shown?.c === s.c && $('posto-sheet').classList.contains('open')) openPosto(s.c);
    render();
  }
  $('posto-body').addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('#posto-mine');
    if (!b || !shown) return;
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1';
      b.textContent = 'Confirmar: ligar ' + ctx.unlinked() + ' abastecimento(s)';
      b.classList.add('primary');
      return;
    }
    const n = await ctx.linkFills(shown);
    ctx.toast(n + (n === 1 ? ' abastecimento ligado a ' : ' abastecimentos ligados a ') + nm(shown));
    setTimeout(() => shown && openPosto(shown.c), 300);
  });
  $('posto-route').addEventListener('click', () => {
    if (!shown) return;
    window.open(mapsUrl(shown, gmatch.get(shown.c)), '_blank', 'noopener');
  });
  $('posto-fill').addEventListener('click', () => {
    if (!shown) return;
    const today = ctx.todayISO();
    const rs = resolve(base);
    const b: Base = 'base' in rs ? rs.base : { kind: 'ponto', at: { lat: shown.la, lon: shown.lo }, radiusKm: 999 };
    const row = stationsFor([shown], b.kind === 'ponto' ? { ...b, radiusKm: 999 } : { ...b, detourKm: 999 }, ctx.car().model, ctx.own(), today, google)[0];
    const best = row.best;
    ctx.closeSheets();
    ctx.fillAt(shown, best?.fuel ?? 'gasolina', best && !best.stale ? best.price.price : null);
  });

  /* ---------- "Outro local" ---------- */
  let localResults: FoundPlace[] = [];
  let localBusy = false;
  function openLocal() {
    localResults = [];
    renderLocal();
    ctx.openSheet('local-sheet');
  }
  function renderLocal() {
    const pl = ctx.places();
    const r = rota();
    const saved: string[] = [];
    for (const k of ['casa', 'trabalho'] as const) {
      const p = place(k);
      if (p) saved.push('<button type="button" class="row nav" data-pick="' + k + '"><span class="ic gray">' + (k === 'casa' ? HOUSE : BAG) + '</span><span class="mid"><span class="a">' + (k === 'casa' ? 'Casa' : 'Trabalho') + '</span><span class="b">' + esc(p.label) + '</span></span><span class="chev">' + ICON.chev + '</span></button>');
    }
    if (r?.on && r.pts.length > 1) saved.push('<button type="button" class="row nav" data-pick="rota"><span class="ic gray">' + PIN + '</span><span class="mid"><span class="a">No caminho casa → trabalho</span><span class="b">Desvio até ' + (r.detour_m < 1000 ? r.detour_m + ' m' : r.detour_m / 1000 + ' km') + '</span></span><span class="chev">' + ICON.chev + '</span></button>');
    void pl;
    $('local-saved').innerHTML = saved.join('') + '<button type="button" class="list-more" data-act="locais">' + (saved.length ? 'Editar casa e trabalho' : 'Cadastrar casa e trabalho') + '</button>';
    $('local-results').innerHTML = localResults.length
      ? localResults.map((x, i) => '<button type="button" class="row simple" data-res="' + i + '"><span class="mid"><span class="a">' + esc(x.label) + '</span><span class="b">' + esc(x.detail) + '</span></span><span></span><span class="chev">' + ICON.chev + '</span></button>').join('')
      : '';
    $('local-results').hidden = !localResults.length;
    $<HTMLButtonElement>('local-go').disabled = localBusy;
  }
  $('local-gps').addEventListener('click', () => {
    ctx.closeSheets();
    base = 'agora';
    here = null;
    locate();
  });
  $('local-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $<HTMLInputElement>('local-q').value.trim();
    if (q.length < 3) return;
    localBusy = true;
    renderLocal();
    try {
      localResults = (await searchPlaces(q, here?.p ?? place('casa'))).list;
      if (!localResults.length) ctx.toast('Nada encontrado. Tente com bairro e cidade.');
    } catch (err) {
      ctx.toast((err as Error).message);
    } finally {
      localBusy = false;
      renderLocal();
    }
  });
  $('local-sheet').addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const res = el.closest<HTMLElement>('[data-res]')?.dataset.res;
    const pick = el.closest<HTMLElement>('[data-pick]')?.dataset.pick;
    if (el.closest('[data-act="locais"]')) { ctx.closeSheets(); return openLocais(); }
    if (res != null) {
      other = localResults[Number(res)];
      base = 'busca';
    } else if (pick) base = pick as BaseKind;
    else return;
    ctx.closeSheets();
    if ($('v-postos').hidden) open(base); else render();
  });

  /* ---------- Casa e trabalho ---------- */
  let editing: 'casa' | 'trabalho' | null = null;
  let found: FoundPlace[] = [];
  let busy = false;
  let routeMsg = '';
  let searchSource: 'google' | 'osm' | null = null;
  function openLocais() {
    editing = place('casa') ? (place('trabalho') ? null : 'trabalho') : 'casa';
    found = [];
    ctx.show('locais');
    renderLocais();
  }
  function renderLocais() {
    if ($('v-locais').hidden) return;
    const typed = document.querySelector<HTMLInputElement>('.pl-form input');
    const keep = typed ? { value: typed.value, focused: document.activeElement === typed } : null;
    const card = (k: 'casa' | 'trabalho') => {
      const p = place(k);
      const head = '<div class="pl-head"><span class="pl-ic ' + k + '">' + (k === 'casa' ? HOUSE : BAG) + '</span><span class="mid"><span class="a">' + (k === 'casa' ? 'Casa' : 'Trabalho') + '</span><span class="b">' + (p ? esc(p.label) : 'Não cadastrado') + '</span></span>' +
        (editing === k ? '' : '<button type="button" class="btn sm" data-edit="' + k + '">' + (p ? 'Editar' : 'Cadastrar') + '</button>') + '</div>';
      if (editing !== k) return '<div class="pl-card">' + head + '</div>';
      return '<div class="pl-card editing">' + head +
        '<form class="pl-form" data-form="' + k + '"><input class="inp sm" name="q" placeholder="Rua e bairro, ou só o bairro" autocomplete="off" enterkeyhint="search" aria-label="Endereço ' + (k === 'casa' ? 'de casa' : 'do trabalho') + '"><button type="submit" class="btn primary sm"' + (busy ? ' disabled' : '') + '>Buscar</button></form>' +
        (found.length ? '<div class="list-card">' + found.map((x, i) => '<button type="button" class="row simple" data-found="' + i + '"><span class="mid"><span class="a">' + esc(x.label) + '</span><span class="b">' + esc(x.detail) + '</span></span><span></span><span class="chev">' + ICON.chev + '</span></button>').join('') + '</div>' + (searchSource === 'google' ? '<span class="hint">Resultados do Google</span>' : searchSource === 'osm' ? '<span class="hint">Resultados do OpenStreetMap</span>' : '') : '') +
        '<div class="pl-actions"><button type="button" class="link-btn" data-here="' + k + '">' + TARGET + ' Usar onde estou agora</button>' +
        (p ? '<button type="button" class="link-btn muted" data-del="' + k + '">Remover</button>' : '') + '<button type="button" class="link-btn muted" data-cancel>Cancelar</button></div></div>';
    };
    const r = rota();
    const both = !!(place('casa') && place('trabalho'));
    const on = !!r?.on && both;
    const det = r?.detour_m ?? 1000;
    $('l-body').innerHTML =
      card('casa') + card('trabalho') +
      '<div class="card"><div class="switch-row"><div class="t"><span>Postos no caminho</span><span>' + (both ? 'Entre casa e trabalho, sem desviar muito' : 'Cadastre casa e trabalho para ligar') + '</span></div><input type="checkbox" class="switch" role="switch" id="l-route" aria-label="Postos no caminho"' + (on ? ' checked' : '') + (both ? '' : ' disabled') + '></div>' +
      (on ? '<div class="field"><span>Desvio máximo</span><div class="chips" id="l-detour">' + DETOURS.map((d) => '<button type="button" data-detour="' + d + '" aria-selected="' + (d === det) + '">' + (d < 1000 ? d + ' m' : d / 1000 + ' km') + '</button>').join('') + '</div></div>' +
        '<span class="hint">' + esc(routeMsg || (r && r.pts.length > 1 ? 'Caminho de ' + fmt(r.km, 1) + ' km (≈ ' + r.min + ' min) calculado.' : 'Calculando o caminho…')) + '</span>' : '') + '</div>' +
      '<p class="foot-note lock">' + ICON.lock + '<span>Salvos na sua conta, só você acessa. Guardamos a rua e o ponto no mapa, sem número. O endereço vai ao serviço de mapas (Google, ou OpenStreetMap se o Google não estiver ligado) só na hora de buscar, e o caminho é calculado uma vez pelo OSRM.</span></p>';
    const input = document.querySelector<HTMLInputElement>('.pl-form input');
    if (input && keep) {
      input.value = keep.value;
      if (keep.focused) input.focus({ preventScroll: true });
    } else if (input) setTimeout(() => input.focus({ preventScroll: true }), 50);
  }

  async function savePlace(k: 'casa' | 'trabalho', x: FoundPlace) {
    await setPlace(k, { label: x.label, lat: Math.round(x.lat * 1e5) / 1e5, lon: Math.round(x.lon * 1e5) / 1e5, data: { detail: x.detail } });
    editing = k === 'casa' && !place('trabalho', await getPlaces()) ? 'trabalho' : null;
    found = [];
    ctx.toast((k === 'casa' ? 'Casa' : 'Trabalho') + ' salvo');
    await refreshRoute();
  }

  /** Recalcula o caminho quando casa ou trabalho mudam (e a opção está ligada). */
  async function refreshRoute(force = false) {
    // lê direto do aparelho: a cópia em memória só atualiza depois que a tela redesenha
    const pl = await getPlaces();
    const c = place('casa', pl), t = place('trabalho', pl), r = rota(pl);
    if (!c || !t || !r?.on) return renderLocais();
    const same = r.pts.length > 1 && !!r.roads && r.from[0] === c.lat && r.from[1] === c.lon && r.to[0] === t.lat && r.to[1] === t.lon;
    if (same && !force) return renderLocais();
    routeMsg = 'Calculando o caminho…';
    renderLocais();
    try {
      const rt = await route(c, t);
      await setPlace('rota', { label: 'Casa → Trabalho', lat: null, lon: null, data: { ...rt, on: true, detour_m: r.detour_m } });
      routeMsg = '';
    } catch (e) {
      routeMsg = (e as Error).message;
    }
    renderLocais();
  }

  $('v-locais').addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    const d = (sel: string) => el.closest<HTMLElement>(sel);
    if (d('[data-edit]')) { editing = d('[data-edit]')!.dataset.edit as 'casa'; found = []; return renderLocais(); }
    if (d('[data-cancel]')) { editing = null; found = []; return renderLocais(); }
    if (d('[data-found]')) return savePlace(editing!, found[Number(d('[data-found]')!.dataset.found)]);
    if (d('[data-del]')) {
      const k = d('[data-del]')!.dataset.del as PlaceKind;
      await setPlace(k, null);
      editing = null;
      return ctx.toast((k === 'casa' ? 'Casa' : 'Trabalho') + ' removido');
    }
    if (d('[data-here]')) {
      const k = d('[data-here]')!.dataset.here as 'casa';
      busy = true;
      try {
        const p = await gps();
        await savePlace(k, await reverse(p));
      } catch (err) {
        ctx.toast((err as Error).message);
      } finally {
        busy = false;
        renderLocais();
      }
      return;
    }
    if (d('[data-detour]') && d('#l-detour')) {
      const r = ctx.places().rota;
      if (r) await setPlace('rota', { label: r.label, lat: null, lon: null, data: { ...r.data, detour_m: Number(d('[data-detour]')!.dataset.detour) } });
    }
  });
  $('v-locais').addEventListener('change', async (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id !== 'l-route') return;
    const r = ctx.places().rota;
    const data = { ...(r && !r.deleted_at ? r.data : {}), on: el.checked, detour_m: (r?.data as any)?.detour_m ?? 1000 };
    await setPlace('rota', { label: 'Casa → Trabalho', lat: null, lon: null, data });
    if (el.checked) refreshRoute();
  });
  $('v-locais').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const q = (form.elements.namedItem('q') as HTMLInputElement).value.trim();
    if (q.length < 3) return;
    busy = true;
    renderLocais();
    try {
      const r = await searchPlaces(q, place('casa') ?? place('trabalho') ?? here?.p);
      found = r.list;
      searchSource = r.source;
      if (!found.length) ctx.toast('Nada encontrado. Tente com bairro e cidade.');
    } catch (err) {
      ctx.toast((err as Error).message);
    } finally {
      busy = false;
      renderLocais();
    }
  });

  /* ---------- card "Onde abastecer" do Início ---------- */
  let homeLoading = false;
  function renderHome() {
    const el = $('home-postos');
    const kind: BaseKind | null = rota()?.on && (rota()?.pts.length ?? 0) > 1 ? 'rota' : place('casa') ? 'casa' : place('trabalho') ? 'trabalho' : null;
    const head = '<div class="title"><span>Onde abastecer</span><button type="button" class="link" data-postos="">Ver postos</button></div>';
    if (!kind) {
      el.innerHTML = head + '<p class="hint">Veja o posto e o combustível que mais compensam perto de você, de casa ou do trabalho.</p><div class="btn-row"><button type="button" class="btn" data-postos="agora">' + TARGET + 'Perto de mim</button><button type="button" class="btn" data-locais>Casa e trabalho</button></div>';
      return;
    }
    if (!file) {
      el.innerHTML = head + '<p class="hint">' + (loadFailed ? 'Lista de postos indisponível agora.' : 'Carregando postos…') + '</p>';
      if (!homeLoading && !loadFailed) {
        homeLoading = true;
        ensureFile().then(() => { homeLoading = false; renderHome(); });
      }
      return;
    }
    const rs = resolve(kind);
    if (!('base' in rs)) { el.innerHTML = head; return; }
    const { rec } = compute(rs.base);
    const where = kind === 'rota' ? 'no seu caminho' : kind === 'casa' ? 'perto de casa' : 'perto do trabalho';
    if (!rec.best) {
      const r = bestWithoutPrice(compute(rs.base).rows);
      el.innerHTML = r
        ? '<button type="button" class="home-rec" data-postos="' + kind + '"><span class="l">Onde abastecer · ' + where + '</span><span class="t">' + esc(nm(r.s)) + '</span><span class="s">Sem preço recente nos postos daqui · melhor avaliado e mais perto (confiabilidade ' + fmt(r.rel.score, 1) + ')</span><span class="chev">' + ICON.chev + '</span></button>'
        : head + '<p class="hint">Sem preço recente nos postos ' + where + '.</p>';
      return;
    }
    const b = rec.best;
    const dist = rs.base.kind === 'rota' ? (b.distKm < 0.15 ? 'no caminho' : '+' + kmTxt(b.extraKm)) : kmTxt(b.distKm);
    el.innerHTML =
      '<button type="button" class="home-rec" data-postos="' + kind + '"><span class="l">Onde abastecer · ' + where + '</span>' +
      '<span class="t"><i class="dot ' + (b.fuel === 'gasolina' ? 'gas' : 'eth') + '"></i>' + FUEL[b.fuel] + ' no ' + esc(nm(b.s)) + '</span>' +
      '<span class="s">' + brl(b.price.price) + '/l · ' + dist + ' · confiabilidade ' + fmt(b.rel.score, 1) + '</span>' +
      (rec.bestOther ? '<span class="s save">' + brl(rec.bestOther.cost - b.cost) + ' a menos que ' + FUEL[rec.bestOther.fuel].toLowerCase() + ' para rodar ' + Math.round(ctx.car().model.kmTank) + ' km</span>' : '') +
      (() => {
        const fav = favorite();
        if (!fav || fav.s.c === b.s.c) return fav ? '<span class="s">É o seu posto de sempre.</span>' : '';
        const o = rowFor(fav.s, rs.base).best;
        if (!o || o.stale) return '';
        const diff = o.cost - b.cost;
        return diff > 0.5 ? '<span class="s">No seu posto (' + esc(nm(fav.s)) + ') sairia ≈ ' + brl(diff) + ' a mais.</span>' : '';
      })() +
      '<span class="chev">' + ICON.chev + '</span></button>';
  }
  $('home-postos').addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const p = el.closest<HTMLElement>('[data-postos]');
    if (el.closest('[data-locais]')) return openLocais();
    if (p) open((p.dataset.postos || undefined) as BaseKind | undefined, 'inicio');
  });

  /** Sugestões para o campo "Posto" do abastecimento: os que você usa e os perto de casa, do trabalho e de onde você está. */
  async function stationChoices(): Promise<{ label: string; id: string }[]> {
    const f = await ensureFile();
    if (!f) return [];
    const out = new Map<string, Station>();
    for (const u of ctx.usage()) {
      const s = f.postos.find((x) => x.c === u.station_id);
      if (s) out.set(s.c, s);
    }
    const centers = [here?.p, place('casa'), place('trabalho')].filter(Boolean) as LatLon[];
    const near = f.postos
      .map((s) => ({ s, d: Math.min(...centers.map((c) => haversineKm(c, { lat: s.la, lon: s.lo }))) }))
      .filter((x) => x.d <= 3)
      .sort((a, b) => a.d - b.d)
      .slice(0, 25);
    for (const x of near) out.set(x.s.c, x.s);
    return [...out.values()].map((s) => ({ label: stationLabel(s), id: s.c }));
  }

  /** Chamado quando os dados do app mudam (sincronização, novo abastecimento, locais). */
  function refresh() {
    renderHome();
    render();
    renderLocais();
    if (!$('local-sheet').classList.contains('open')) return;
    renderLocal();
  }

  return { open, openLocais, refresh, renderHome, stationChoices, BASE_LABEL };
}
