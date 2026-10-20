import '@fontsource/geist/latin-400.css';
import '@fontsource/geist/latin-500.css';
import '@fontsource/geist/latin-600.css';
import '@fontsource/geist/latin-700.css';
import './styles.css';

import { liveQuery } from 'dexie';
import { registerSW } from 'virtual:pwa-register';
import { db, getMeta, setMeta, softDelete, stamp, uuid, type FuelLog, type FuelType, type PendingFile, type Service, type ServiceItem, type Vehicle, type VehicleFuel } from './db';
import { aggregate, intervals, kmPerDay, parseIntLoose, parseNum, sortLogs, type Interval } from './calc';
import { exportBackup, importBackup } from './backup';
import { currentSession, getHomePrefs, getPlaces, onSyncStatus, scheduleSync, sendLoginEmail, setHomePrefs, signOut, startAutoSync, supabase, sync, verifyCode, type HomePrefs, type Places, type SyncStatus } from './sync';
import { initPostos, type CarInfo } from './postos-ui';
import type { Fuel, OwnPrice, Station } from './postos';
import { initMaintenance, currentKmOf } from './manut';
import { itemStates, lastDoneByKey, progressOf, sortStates } from './maintenance';
import { planByKey } from './plans';
import { CATALOG, computeIndicators, monthKey, monthName, monthlySpend, pricePoints, tankSeries, type IndicatorId, type Period } from './indicators';
import { kmlBars, monthBars, priceLine, sparkBars } from './charts';
import { ICON } from './icons';

declare const __BUILD__: string;

/* ---------- helpers ---------- */
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
const brl = (n: number) => 'R$ ' + fmt(n, 2);
const km = (n: number) => (Number.isFinite(n) ? Math.round(n).toLocaleString('pt-BR') : '–');
const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const dm = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
const monthYear = (iso: string) => MES[+iso.slice(5, 7) - 1] + '/' + iso.slice(2, 4);
const pl = (n: number, one: string, many: string) => n + ' ' + (n === 1 ? one : many);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
const FUEL_LABEL: Record<FuelType, string> = { gasolina: 'Gasolina', etanol: 'Etanol', diesel: 'Diesel', gnv: 'GNV' };
const SVC_LABEL: Record<Service['type'], string> = { revisao: 'Revisão', corretiva: 'Conserto', pneus: 'Pneus', outros: 'Manutenção' };

/* ---------- estado ---------- */
interface CalcCfg { gas: string; eth: string; ratio: number }
interface State {
  vehicles: Vehicle[];
  logs: FuelLog[];
  currentId: string | null;
  calc: CalcCfg;
  pending: number;
  services: Service[];
  items: ServiceItem[];
  files: PendingFile[];
  prefs: HomePrefs;
  places: Places;
}
let S: State = {
  vehicles: [], logs: [], currentId: null, calc: { gas: '', eth: '', ratio: 0.7 }, pending: 0, services: [], items: [], files: [],
  prefs: { ids: ['gasto_mes', 'km_mes'], updated_at: '', dirty: false },
  places: {},
};
let view = 'inicio';
let histFilter: 'tudo' | 'abast' | 'manut' = 'tudo';
let period: Period = 'tudo';

const activeVehicles = () => S.vehicles.filter((v) => !v.archived).sort((a, b) => a.name.localeCompare(b.name));
const current = (): Vehicle | undefined => S.vehicles.find((v) => v.id === S.currentId && !v.archived) ?? activeVehicles()[0];
const carLogs = (): FuelLog[] => {
  const v = current();
  return v ? sortLogs(S.logs.filter((f) => f.vehicle_id === v.id)) : [];
};
const carServices = () => {
  const v = current();
  return v ? S.services.filter((s) => s.vehicle_id === v.id) : [];
};

const maint = initMaintenance({ $, fmt, brl, km, esc, pl, todayISO, toast, openSheet, closeSheets, parseNum, parseIntLoose });

/** Rendimento do carro atual para comparar postos e combustíveis. */
function carInfo(): CarInfo {
  const v = current();
  const iv = intervals(carLogs());
  const g = aggregate(iv.filter((x) => x.fuel === 'gasolina'));
  const e = aggregate(iv.filter((x) => x.fuel === 'etanol'));
  // Um tanque fora da curva não pode virar o rendimento do etanol: fora de 55–85%, volta à regra dos 70%
  const raw = g.n > 0 && e.n > 0 ? e.kml / g.kml : NaN;
  const measured = raw >= 0.55 && raw <= 0.85;
  const ratio = measured ? raw : Number(S.calc.ratio) || 0.7;
  const kmlG = g.n ? g.kml : e.n ? e.kml / ratio : 10;
  const kmlE = measured ? e.kml : kmlG * ratio;
  const fulls = carLogs().filter((f) => f.full_tank).slice(-6);
  const liters = fulls.length ? fulls.reduce((a, f) => a + f.liters, 0) / fulls.length : 45;
  const ft = v?.fuel_type ?? 'flex';
  const fuels: Fuel[] = ft === 'flex' ? ['gasolina', 'etanol'] : ft === 'gasolina' ? ['gasolina'] : ft === 'etanol' ? ['etanol'] : [];
  return { name: v?.name ?? 'carro', model: { kmlG, kmlE, measured, fuels, kmTank: Math.max(100, Math.round((liters * kmlG) / 10) * 10) } };
}

const postos = initPostos({
  $, fmt, brl, esc, toast, openSheet, closeSheets, show, todayISO,
  car: carInfo,
  own: (): OwnPrice[] =>
    S.logs.filter((f) => f.station_id && (f.fuel === 'gasolina' || f.fuel === 'etanol')).map((f) => ({ station_id: f.station_id!, fuel: f.fuel as Fuel, price: f.price_per_l || f.total_brl / f.liters, date: f.date })),
  logsAt: (cnpj) => S.logs.filter((f) => f.station_id === cnpj).sort((a, b) => b.date.localeCompare(a.date)),
  places: () => S.places,
  fillAt: (s, fuel, price) => openFillAt(s, fuel, price),
});

liveQuery(async () => {
  const [vehicles, logs, currentId, calc, dirty, services, items, files, prefs, places] = await Promise.all([
    db.vehicles.toArray(),
    db.fuel_logs.toArray(),
    getMeta<string | null>('current_vehicle', null),
    getMeta<CalcCfg>('calc', { gas: '', eth: '', ratio: 0.7 }),
    Promise.all([db.vehicles, db.fuel_logs, db.services, db.service_items].map((t: any) => t.where('_dirty').equals(1).count())),
    db.services.toArray(),
    db.service_items.toArray(),
    db.pending_files.toArray(),
    getHomePrefs(),
    getPlaces(),
  ]);
  return {
    vehicles: vehicles.filter((v) => !v.deleted_at),
    logs: logs.filter((f) => !f.deleted_at),
    currentId,
    calc,
    pending: dirty.reduce((a: number, b: number) => a + b, 0),
    services: services.filter((x) => !x.deleted_at),
    items: items.filter((x) => !x.deleted_at),
    files,
    prefs,
    places,
  } as State;
}).subscribe({
  next: (s) => {
    S = s;
    render();
    renderSync();
    if (S.pending > 0 && syncStatus.kind !== 'signed-out') scheduleSync();
  },
  error: (e) => {
    console.error(e);
    toast('Não consegui ler a base deste aparelho. Feche e abra o app de novo.');
  },
});

/* ---------- render ---------- */
function indInput() {
  const v = current()!;
  return { vehicleId: v.id, logs: carLogs(), services: S.services, items: S.items, today: todayISO() };
}

function render() {
  const v = current();
  const fs = carLogs();
  const iv = intervals(fs);
  $('car-name').textContent = v ? v.name : 'Cadastrar carro';
  renderInicio(v, fs, iv);
  renderHist(v, fs, iv);
  renderMais(v);
  renderIndicadores(v);
  renderCalc(v, fs, iv);
  maint.render({ vehicle: v, logs: fs, services: S.services, items: S.items, pending: S.files });
  postos.refresh();
}

function renderInicio(v: Vehicle | undefined, fs: FuelLog[], iv: Interval[]) {
  const empty = !v;
  $('home-empty').hidden = !empty;
  ['hero', 'home-inds-head', 'home-inds', 'home-next'].forEach((id) => ($(id).hidden = empty));
  if (!v) return;
  const all = aggregate(iv);
  if (iv.length) {
    $('h-avg').textContent = fmt(all.kml, 2);
    const l3 = aggregate(iv.slice(-3));
    $('h-sub').innerHTML = (iv.length >= 3 ? 'Últimos 3 tanques: <b>' + fmt(l3.kml, 2) + '</b> · ' : '') + km(all.km) + ' km medidos';
  } else {
    $('h-avg').textContent = '–';
    $('h-sub').textContent = fs.length ? 'Registre mais um tanque cheio para calcular o consumo.' : 'Toque em Abastecer para registrar o primeiro abastecimento.';
  }
  $('spark').innerHTML = sparkBars(iv);

  // Indicadores escolhidos
  const today = todayISO();
  $('h-month').textContent = cap(monthName(monthKey(today)));
  const ind = computeIndicators(indInput());
  const ids = S.prefs.ids.filter((id) => CATALOG.some((c) => c.id === id));
  const ordered = CATALOG.filter((c) => ids.includes(c.id));
  $('home-inds').hidden = !ordered.length;
  $('home-inds').innerHTML = ordered
    .map((c) => {
      const x = ind[c.id];
      return '<div class="stat"><span class="k">' + esc(x.name) + '</span><span class="v">' + esc(x.value) + '</span><span class="s">' + esc(x.sub) + '</span></div>';
    })
    .join('');
  $('h-month').textContent = ordered.length ? cap(monthName(monthKey(today))) : 'Indicadores';

  // Próxima manutenção
  $('home-next').innerHTML = nextMaintenanceCard(v, fs);
}

function nextMaintenanceCard(v: Vehicle, fs: FuelLog[]): string {
  const plan = planByKey(v.plan_key);
  if (!plan) return '';
  const curKm = currentKmOf(v, fs, S.services);
  const today = todayISO();
  const states = sortStates(itemStates(plan, lastDoneByKey(v.id, S.services, S.items), curKm, today, kmPerDay(fs)));
  const dated = states.filter((s) => s.status === 'vencida' || s.status === 'proxima' || s.status === 'em_dia');
  if (!dated.length) {
    return '<button type="button" class="next-card" data-go="manut"><div class="next-head"><div class="next-title"><span class="ic">' + ICON.wrench + '</span><span class="t"><span>Manutenção</span><span>Registre a última revisão</span></span></div></div><span class="hint">Com ela o app calcula as próximas trocas do plano ' + esc(plan.name) + '.</span></button>';
  }
  const first = dated[0];
  const group = dated.filter((s) => s.due_km === first.due_km && s.due_date === first.due_date && s.status === first.status);
  const names = group.map((s) => s.item.description);
  const title = (first.item.action === 'inspecionar' ? 'Inspeção: ' : 'Troca: ') + (names.length > 1 ? names.slice(0, -1).join(', ') + ' e ' + names[names.length - 1].toLowerCase() : names[0]);
  const pct = progressOf(first, curKm, today);
  const chip = { vencida: 'Vencida', proxima: 'Próxima', em_dia: 'Em dia' }[first.status as 'vencida'];
  let left = '';
  if (first.remaining_km != null) left = first.remaining_km > 0 ? 'Faltam <b>' + km(first.remaining_km) + ' km</b>' : 'Passou <b>' + km(-first.remaining_km) + ' km</b>';
  else if (first.remaining_days != null) left = first.remaining_days > 0 ? 'Faltam <b>' + pl(first.remaining_days, 'dia', 'dias') + '</b>' : 'Venceu há <b>' + pl(-first.remaining_days, 'dia', 'dias') + '</b>';
  const right = [first.due_km != null ? km(first.due_km) + ' km' : '', first.due_date ? 'até ' + monthYear(first.due_date) : '', first.status !== 'vencida' && first.est_date && first.due_km != null ? '≈ ' + monthYear(first.est_date) : ''].filter(Boolean).join(' · ');
  return (
    '<button type="button" class="next-card" data-go="manut"><div class="next-head"><div class="next-title"><span class="ic">' + ICON.wrench + '</span><span class="t"><span>Próxima manutenção</span><span>' + esc(title) + '</span></span></div>' +
    '<span class="chip ' + first.status + '">' + chip + '</span></div>' +
    (pct != null ? '<div class="bar ' + first.status + '"><i style="width:' + Math.round(pct * 100) + '%"></i></div>' : '') +
    '<div class="row-meta"><span>' + left + '</span><span>' + esc(right) + '</span></div></button>'
  );
}

function renderHist(v: Vehicle | undefined, fs: FuelLog[], iv: Interval[]) {
  $('hist-car').textContent = v?.name ?? '';
  document.querySelectorAll<HTMLElement>('#hist-filter button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.f === histFilter)));
  if (!v) {
    $('hist').innerHTML = '<div class="empty">Cadastre um carro para começar.</div>';
    return;
  }
  const byId = new Map(iv.map((x) => [x.id, x]));
  type Entry = { date: string; odo: number; html: string; total: number; kind: 'f' | 's' };
  const entries: Entry[] = [];
  if (histFilter !== 'manut') {
    const firstFull = fs.find((f) => f.full_tank);
    for (const f of fs) {
      const i = byId.get(f.id);
      const metric = i ? fmt(i.kml, 2) + ' km/l' : !f.full_tank ? 'parcial' : f === firstFull ? 'primeiro tanque' : '–';
      const sub = [dm(f.date), km(f.odometer_km) + ' km', 'R$ ' + fmt(f.price_per_l || f.total_brl / f.liters, 2) + '/l', f.station ? esc(f.station) : ''].filter(Boolean).join(' · ');
      entries.push({
        date: f.date, odo: f.odometer_km, total: f.total_brl, kind: 'f',
        html: '<button type="button" class="row" data-fill="' + esc(f.id) + '"><span class="ic ' + f.fuel + '">' + ICON.pump + '</span><span class="mid"><span class="a">' + FUEL_LABEL[f.fuel] + ' · ' + fmt(f.liters, 2) + ' l</span><span class="b">' + sub + '</span></span><span class="end"><span class="a">' + brl(f.total_brl) + '</span><span class="b' + (f.full_tank ? '' : ' part') + '">' + metric + '</span></span></button>',
      });
    }
  }
  if (histFilter !== 'abast') {
    for (const s of carServices()) {
      const its = S.items.filter((i) => i.service_id === s.id);
      const tot = its.reduce((a, i) => a + i.parts_brl + i.labor_brl, 0);
      const hasAtt = !!s.attachment_path || S.files.some((p) => p.service_id === s.id);
      const sub = [dm(s.date), s.odometer_km ? km(s.odometer_km) + ' km' : '', pl(its.length, 'item', 'itens')].filter(Boolean).join(' · ');
      entries.push({
        date: s.date, odo: s.odometer_km ?? 0, total: tot, kind: 's',
        html: '<button type="button" class="row" data-svc="' + esc(s.id) + '"><span class="ic svc">' + ICON.wrench + '</span><span class="mid"><span class="a">' + esc(SVC_LABEL[s.type] + (s.shop ? ' · ' + s.shop : '')) + '</span><span class="b">' + sub + '</span></span><span class="end"><span class="a">' + brl(tot) + '</span><span class="b' + (hasAtt ? ' blue' : '') + '">' + (hasAtt ? 'OS anexada' : 'manutenção') + '</span></span></button>',
      });
    }
  }
  if (!entries.length) {
    $('hist').innerHTML = '<div class="empty">' + (histFilter === 'manut' ? 'Nenhuma manutenção registrada.' : 'Nenhum abastecimento ainda.') + '</div>';
    return;
  }
  entries.sort((a, b) => b.date.localeCompare(a.date) || b.odo - a.odo);
  const thisYear = todayISO().slice(0, 4);
  const months = new Map<string, Entry[]>();
  for (const e of entries) {
    const k = monthKey(e.date);
    if (!months.has(k)) months.set(k, []);
    months.get(k)!.push(e);
  }
  $('hist').innerHTML = [...months.entries()]
    .map(([k, list]) => {
      const total = list.reduce((a, e) => a + e.total, 0);
      const nf = list.filter((e) => e.kind === 'f').length;
      const ns = list.filter((e) => e.kind === 's').length;
      const parts = [nf ? pl(nf, 'abastecimento', 'abastecimentos') : '', ns ? pl(ns, 'manutenção', 'manutenções') : ''].filter(Boolean).join(' + ');
      return (
        '<div class="month-head"><span>' + cap(monthName(k)) + (k.slice(0, 4) !== thisYear ? ' ' + k.slice(0, 4) : '') + '</span><span>' + brl(total) + ' · ' + parts + '</span></div>' +
        '<div class="list-card">' + list.map((e) => e.html).join('') + '</div>'
      );
    })
    .join('');
}

function renderMais(v: Vehicle | undefined) {
  const cars = activeVehicles().map((c) => c.name).join(' · ') || 'Nenhum cadastrado';
  const pin = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
  const pls = [S.places.casa, S.places.trabalho].filter((p) => p && !p.deleted_at).length;
  $('mais-1').innerHTML =
    '<button type="button" class="row nav" data-go="postos"><span class="ic orange">' + ICON.pump + '</span><span class="mid"><span class="a">Onde abastecer</span><span class="b">Postos, preços e confiabilidade</span></span><span class="chev">' + ICON.chev + '</span></button>' +
    '<button type="button" class="row nav" data-go="locais"><span class="ic orange">' + pin + '</span><span class="mid"><span class="a">Casa e trabalho</span><span class="b">' + (pls === 2 ? 'Cadastrados' : pls === 1 ? 'Falta um endereço' : 'Base para comparar postos') + '</span></span><span class="chev">' + ICON.chev + '</span></button>' +
    '<button type="button" class="row nav" data-go="indicadores"><span class="ic blue">' + ICON.chart + '</span><span class="mid"><span class="a">Indicadores</span><span class="b">Gráficos e o que aparece no início</span></span><span class="chev">' + ICON.chev + '</span></button>' +
    '<button type="button" class="row nav" data-go="etanol"><span class="ic green">%</span><span class="mid"><span class="a">Etanol × gasolina</span><span class="b">Calculadora com o rendimento do seu carro</span></span><span class="chev">' + ICON.chev + '</span></button>' +
    '<button type="button" class="row nav" id="mais-cars"><span class="ic gray">' + activeVehicles().length + '</span><span class="mid"><span class="a">Carros</span><span class="b">' + esc(cars) + '</span></span><span class="chev">' + ICON.chev + '</span></button>';
  $('mais-2').innerHTML =
    '<button type="button" class="row simple" data-sheet="set"><span class="mid"><span class="a" style="font-weight:500">Conta e sincronização</span></span><span class="b muted" style="font-size:13px">' + esc(syncText()[1]) + '</span><span class="chev">' + ICON.chev + '</span></button>' +
    '<button type="button" class="row simple" data-sheet="set"><span class="mid"><span class="a" style="font-weight:500">Backup e dados</span></span><span class="b muted" style="font-size:13px">Exportar ou importar</span><span class="chev">' + ICON.chev + '</span></button>';
  void v;
}

function renderIndicadores(v: Vehicle | undefined) {
  if (!v) {
    $('ind-list').innerHTML = '<div class="empty">Cadastre um carro para ver os indicadores.</div>';
    ['ch-month', 'ch-price', 'ch-kml'].forEach((id) => ($(id).innerHTML = ''));
    return;
  }
  $('ind-car').textContent = v.name + ' · escolha o que aparece no início';
  const input = indInput();
  const ind = computeIndicators(input);
  const iv = intervals(input.logs);
  const avg = aggregate(iv).kml;
  const focused = document.activeElement as HTMLElement | null;
  const focusedId = focused?.dataset?.ind;
  $('ind-list').innerHTML =
    '<div class="ind-row"><span class="mid"><span>Consumo médio</span><span>' + (Number.isFinite(avg) ? fmt(avg, 2) + ' km/l · ' : '') + 'sempre em destaque</span></span><span class="muted">' + ICON.lock + '</span></div>' +
    CATALOG.map((c) => {
      const x = ind[c.id];
      const on = S.prefs.ids.includes(c.id);
      return '<div class="ind-row"><span class="mid"><span>' + esc(x.name) + '</span><span>' + esc(x.value + (x.sub ? ' · ' + x.sub : '')) + '</span></span><input type="checkbox" class="switch" role="switch" data-ind="' + c.id + '"' + (on ? ' checked' : '') + ' aria-label="Mostrar no início: ' + esc(x.name) + '"></div>';
    }).join('');
  if (focusedId) document.querySelector<HTMLElement>('[data-ind="' + focusedId + '"]')?.focus();
  document.querySelectorAll<HTMLElement>('#ind-period button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.p === period)));
  $('ch-month').innerHTML = monthBars(monthlySpend(input, period));
  const pts = pricePoints(input, period);
  $('ch-price').innerHTML = priceLine(pts);
  const totL = input.logs.reduce((s, f) => s + f.liters, 0);
  $('ch-price-avg').textContent = totL ? 'média ' + brl(input.logs.reduce((s, f) => s + f.total_brl, 0) / totL) : '';
  const t = tankSeries(input, period);
  $('ch-kml').innerHTML = kmlBars(t.list, t.avg);
  $('ch-kml-avg').textContent = Number.isFinite(t.avg) ? 'média ' + fmt(t.avg, 2) : '';
}

$('ind-list').addEventListener('change', async (e) => {
  const el = e.target as HTMLInputElement;
  if (!el.dataset.ind) return;
  const on = new Set(S.prefs.ids);
  if (el.checked) on.add(el.dataset.ind as IndicatorId);
  else on.delete(el.dataset.ind as IndicatorId);
  await setHomePrefs(CATALOG.map((c) => c.id).filter((id) => on.has(id)));
});
$('ind-period').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-p]');
  if (!b) return;
  period = b.dataset.p as Period;
  renderIndicadores(current());
});

/* ---------- etanol × gasolina ---------- */
function calcModel(v: Vehicle | undefined, fs: FuelLog[], iv: Interval[]) {
  const c = S.calc;
  const lastGas = [...fs].reverse().find((f) => f.fuel === 'gasolina');
  const gasDefault = lastGas ? lastGas.price_per_l || lastGas.total_brl / lastGas.liters : NaN;
  const g = aggregate(iv.filter((x) => x.fuel === 'gasolina'));
  const e = aggregate(iv.filter((x) => x.fuel === 'etanol'));
  const measured = g.n > 0 && e.n > 0;
  const ratio = measured ? e.kml / g.kml : Number(c.ratio) || 0.7;
  const gas = Number.isFinite(parseNum(c.gas)) ? parseNum(c.gas) : gasDefault;
  const eth = parseNum(c.eth);
  const kmlG = g.n ? g.kml : NaN;
  const kmlE = e.n ? e.kml : kmlG * ratio;
  return { gasDefault, measured, ratio, gas, eth, kmlG, kmlE, eN: e.n, flex: !v || v.fuel_type === 'flex', kmMonth: kmPerDay(fs) * 30, gK: g, eK: e };
}

function renderCalc(v: Vehicle | undefined, fs: FuelLog[], iv: Interval[]) {
  const m = calcModel(v, fs, iv);
  const c = S.calc;
  for (const [gasId, ethId] of [['c-gas', 'c-eth']]) {
    const g = $<HTMLInputElement>(gasId), e = $<HTMLInputElement>(ethId);
    if (document.activeElement !== g) g.value = c.gas || '';
    if (document.activeElement !== e) e.value = c.eth || '';
    if (Number.isFinite(m.gasDefault)) g.placeholder = fmt(m.gasDefault, 2);
  }
  const thr = m.gas * m.ratio;
  const rEl = $<HTMLInputElement>('c-ratio');
  rEl.disabled = m.measured;
  if (document.activeElement !== rEl) rEl.value = m.ratio.toFixed(2);
  $('c-ratio-out').textContent = Math.round(m.ratio * 100) + '%';
  $('c-ratio-hint').textContent = !m.flex
    ? 'Este carro não é flex; a comparação serve só como referência.'
    : m.measured
      ? 'Medido neste carro: ' + fmt(m.eK.kml, 2) + ' km/l no etanol vs ' + fmt(m.gK.kml, 2) + ' na gasolina.'
      : 'Estimativa pela regra dos 70%. Quando você registrar tanques de etanol, o app passa a usar o rendimento real.';
  $('c-thr').textContent = Number.isFinite(m.gas) ? brl(thr) : '–';
  $('c-thr-sub').textContent = Number.isFinite(m.gas) ? 'com gasolina a ' + brl(m.gas) + ' e rendimento de ' + Math.round(m.ratio * 100) + '%' : 'Informe o preço da gasolina.';
  const box = $('c-verdict');
  if (!Number.isFinite(m.gas) || !Number.isFinite(m.eth)) {
    box.innerHTML = '<span class="hint">Digite o preço do etanol no posto para ver qual compensa.</span>';
    return;
  }
  const pct = m.eth / m.gas;
  const ethWins = pct < m.ratio;
  const rpkG = m.gas / m.kmlG, rpkE = m.eth / m.kmlE;
  const diffM = Math.abs(rpkG - rpkE) * m.kmMonth;
  box.innerHTML =
    '<span class="hint">Etanol custa ' + fmt(pct * 100, 1) + '% da gasolina</span>' +
    '<span style="font-size:28px;font-weight:600;letter-spacing:-.5px;color:var(' + (ethWins ? '--eth' : '--gas') + ')">' + (ethWins ? 'Vá de etanol' : 'Fique na gasolina') + '</span>' +
    (Number.isFinite(rpkG)
      ? '<div class="grid2"><div><div class="hint">Gasolina</div><div style="font-size:20px;font-weight:600">' + brl(rpkG) + '/km</div><div class="hint">' + fmt(m.kmlG, 2) + ' km/l</div></div><div><div class="hint">Etanol</div><div style="font-size:20px;font-weight:600">' + brl(rpkE) + '/km</div><div class="hint">' + fmt(m.kmlE, 2) + ' km/l' + (m.eN ? '' : ' (estimado)') + '</div></div></div>'
      : '') +
    (Number.isFinite(diffM) ? '<span class="hint">Diferença de ≈ ' + brl(diffM) + ' por mês no seu ritmo de ' + km(m.kmMonth) + ' km.</span>' : '');
}

let calcTimer: number | undefined;
function saveCalc(patch: Partial<CalcCfg>) {
  S.calc = { ...S.calc, ...patch };
  renderCalc(current(), carLogs(), intervals(carLogs()));
  clearTimeout(calcTimer);
  calcTimer = window.setTimeout(() => setMeta('calc', S.calc), 400);
}
for (const id of ['c-gas']) $(id).addEventListener('input', (e) => saveCalc({ gas: (e.target as HTMLInputElement).value }));
for (const id of ['c-eth']) $(id).addEventListener('input', (e) => saveCalc({ eth: (e.target as HTMLInputElement).value }));
$('c-ratio').addEventListener('input', (e) => saveCalc({ ratio: Number((e.target as HTMLInputElement).value) }));

/* ---------- navegação ---------- */
const TAB_OF: Record<string, string> = { inicio: 'inicio', hist: 'hist', manut: 'manut', mais: 'mais', indicadores: 'mais', etanol: 'mais', locais: 'mais' };
let tab = 'inicio';
function show(next: string) {
  view = next;
  // Postos abre a partir do Início ou do Mais: a aba de origem continua marcada
  tab = TAB_OF[next] ?? tab;
  document.querySelectorAll<HTMLElement>('main > .view').forEach((s) => (s.hidden = s.id !== 'v-' + next));
  document.querySelectorAll<HTMLElement>('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === tab)));
  window.scrollTo(0, 0);
}
document.querySelectorAll<HTMLElement>('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.view!)));
document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-go],[data-sheet],#mais-cars');
  if (!el) return;
  if (el.dataset.go === 'postos') return postos.open(undefined, tab);
  if (el.dataset.go === 'locais') return postos.openLocais();
  if (el.dataset.go) return show(el.dataset.go);
  if (el.dataset.sheet === 'set') return openSettings();
  if (el.id === 'mais-cars') return openCars();
});
$('hist-filter').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-f]');
  if (!b) return;
  histFilter = b.dataset.f as typeof histFilter;
  renderHist(current(), carLogs(), intervals(carLogs()));
});
$('hist').addEventListener('click', (e) => {
  const r = (e.target as HTMLElement).closest<HTMLElement>('[data-fill],[data-svc]');
  if (!r) return;
  if (r.dataset.fill) openFill(r.dataset.fill);
  else maint.openService(r.dataset.svc!);
});
$('e-add-car').addEventListener('click', () => openVehicle(null));
$('e-import').addEventListener('click', () => $<HTMLInputElement>('imp-file').click());

/* ---------- folhas ---------- */
function openSheet(id: string) {
  document.querySelectorAll('.sheet').forEach((s) => s.classList.toggle('open', s.id === id));
  $('scrim').classList.add('open');
}
function closeSheets() {
  document.querySelectorAll('.sheet').forEach((s) => s.classList.remove('open'));
  $('scrim').classList.remove('open');
}
$('scrim').addEventListener('click', closeSheets);
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));

/* ---------- abastecimento ---------- */
let editing: FuelLog | null = null;
/** Posto escolhido em "Abastecer aqui" (CNPJ e nome), gravado junto se o nome não for trocado. */
let fillStation: { id: string; name: string } | null = null;
let delArmed = false;
let recent: string[] = [];
const FIELD_OF = { total: 'fld-total', liters: 'fld-liters', price: 'fld-price' } as const;

function openFill(id: string | null) {
  const v = current();
  if (!v) {
    toast('Cadastre o carro primeiro.');
    openVehicle(null);
    return;
  }
  editing = id ? S.logs.find((f) => f.id === id) ?? null : null;
  fillStation = editing?.station_id && editing.station ? { id: editing.station_id, name: editing.station } : null;
  delArmed = false;
  const del = $('f-del');
  del.hidden = !editing;
  del.classList.remove('armed');
  del.textContent = 'Excluir';
  $('fill-title').textContent = editing ? 'Editar abastecimento' : 'Novo abastecimento';
  $('f-err').hidden = true;
  const fs = carLogs();
  const last = fs[fs.length - 1];
  const flex = v.fuel_type === 'flex';
  $('f-fuel-seg').hidden = !flex;
  const fuel: FuelType = editing?.fuel ?? (flex ? last?.fuel ?? 'gasolina' : (v.fuel_type as FuelType));
  const set = (i: string, val: string) => ($<HTMLInputElement>(i).value = val);
  set('f-date', editing?.date ?? todayISO());
  set('f-total', editing ? fmt(editing.total_brl, 2) : '');
  set('f-liters', editing ? fmt(editing.liters, editing.liters % 1 && String(editing.liters).split('.')[1]?.length > 2 ? 3 : 2) : '');
  set('f-price', editing ? fmt(editing.price_per_l, 3) : '');
  set('f-odo', editing ? String(editing.odometer_km) : '');
  set('f-range', editing?.range_left_km != null ? String(editing.range_left_km) : '');
  set('f-station', editing?.station ?? '');
  set('f-note', editing?.note ?? '');
  $<HTMLInputElement>('f-full').checked = editing ? editing.full_tank : true;
  $<HTMLInputElement>(fuel === 'etanol' ? 'f-fuel-e' : 'f-fuel-g').checked = true;
  $<HTMLInputElement>('f-odo').placeholder = last ? String(last.odometer_km + 380) : v.initial_km ? String(v.initial_km) : '';
  const lastStation = [...fs].reverse().find((f) => f.station)?.station;
  $<HTMLInputElement>('f-station').placeholder = lastStation ?? 'Opcional';
  $<HTMLInputElement>('f-price').placeholder = last ? fmt(last.price_per_l, 2) : '0,00';
  ($('f-more') as HTMLDetailsElement).open = !!(editing && (editing.station || editing.note || editing.range_left_km != null));
  recent = editing ? ['total', 'liters'] : [];
  Object.values(FIELD_OF).forEach((f) => $(f).classList.remove('auto'));
  updateFillHints();
  openSheet('fill-sheet');
  if (!editing) setTimeout(() => $('f-total').focus({ preventScroll: true }), 260);
}
$('add-btn').addEventListener('click', () => openFill(null));

function openFillAt(s: Station, fuel: Fuel, price: number | null) {
  openFill(null);
  if (!current()) return;
  fillStation = { id: s.c, name: s.n };
  $<HTMLInputElement>('f-station').value = s.n;
  if (current()!.fuel_type === 'flex') $<HTMLInputElement>(fuel === 'etanol' ? 'f-fuel-e' : 'f-fuel-g').checked = true;
  if (price) {
    $<HTMLInputElement>('f-price').value = fmt(price, Math.round(price * 1000) % 10 ? 3 : 2);
    recent = ['price'];
  }
  updateFillHints();
}

function updateFillHints() {
  const v = current();
  if (!v) return;
  const others = carLogs().filter((f) => !editing || f.id !== editing.id);
  const odo = parseIntLoose($<HTMLInputElement>('f-odo').value);
  const before = Number.isFinite(odo) ? others.filter((f) => f.odometer_km < odo).pop() : others[others.length - 1];
  const hint = $('f-hint');
  if (before && Number.isFinite(odo)) hint.textContent = km(odo - before.odometer_km) + ' km desde o abastecimento anterior (' + km(before.odometer_km) + ' km)';
  else if (before) hint.textContent = 'Último odômetro: ' + km(before.odometer_km) + ' km';
  else hint.textContent = '';
  const date = $<HTMLInputElement>('f-date').value;
  const station = $<HTMLInputElement>('f-station').value.trim();
  $('f-more-sum').textContent = [date === todayISO() ? 'hoje' : date ? dm(date) : '', station].filter(Boolean).join(' · ');
  // Prévia do consumo deste tanque
  const prev = $('f-preview');
  const liters = parseNum($<HTMLInputElement>('f-liters').value);
  const full = $<HTMLInputElement>('f-full').checked;
  const prevFull = Number.isFinite(odo) ? others.filter((f) => f.full_tank && f.odometer_km < odo).pop() : undefined;
  if (!full || !(liters > 0) || !Number.isFinite(odo) || !prevFull) {
    prev.hidden = true;
    return;
  }
  const partials = others.filter((f) => !f.full_tank && f.odometer_km > prevFull.odometer_km && f.odometer_km < odo).reduce((s, f) => s + f.liters, 0);
  const kml = (odo - prevFull.odometer_km) / (liters + partials);
  const avg = aggregate(intervals(others)).kml;
  if (!(kml > 0) || kml > 60) {
    prev.hidden = true;
    return;
  }
  const better = !Number.isFinite(avg) || kml >= avg;
  prev.className = 'good' + (better ? '' : ' low');
  prev.innerHTML = (better ? ICON.trendUp : ICON.trendDown) + '<div><b>' + fmt(kml, 2) + ' km/l</b> neste tanque' + (Number.isFinite(avg) ? '<br>' + (better ? 'acima' : 'abaixo') + ' da sua média de ' + fmt(avg, 2) : '') + '</div>';
  prev.hidden = false;
}

(['total', 'liters', 'price'] as const).forEach((k) =>
  $('f-' + k).addEventListener('input', () => {
    recent = recent.filter((x) => x !== k);
    recent.push(k);
    if (recent.length > 2) recent.shift();
    $(FIELD_OF[k]).classList.remove('auto');
    if (recent.length >= 2) {
      const target = (['total', 'liters', 'price'] as const).find((x) => !recent.includes(x))!;
      const t = parseNum($<HTMLInputElement>('f-total').value), l = parseNum($<HTMLInputElement>('f-liters').value), p = parseNum($<HTMLInputElement>('f-price').value);
      let val = NaN, d = 2;
      if (target === 'price' && t > 0 && l > 0) { val = t / l; d = 3; }
      else if (target === 'total' && l > 0 && p > 0) val = l * p;
      else if (target === 'liters' && t > 0 && p > 0) { val = t / p; d = 3; }
      if (Number.isFinite(val)) {
        $<HTMLInputElement>('f-' + target).value = fmt(val, d);
        $(FIELD_OF[target]).classList.add('auto');
      }
    }
    updateFillHints();
  }),
);
for (const id of ['f-odo', 'f-date', 'f-station']) $(id).addEventListener('input', updateFillHints);
$('f-full').addEventListener('change', updateFillHints);

$('f-del').addEventListener('click', async () => {
  if (!editing) return;
  if (!delArmed) {
    delArmed = true;
    $('f-del').classList.add('armed');
    $('f-del').textContent = 'Confirmar';
    return;
  }
  await softDelete(db.fuel_logs, editing.id);
  closeSheets();
  toast('Abastecimento excluído');
});

$('fill-sheet').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = current()!;
  const val = (id: string) => $<HTMLInputElement>(id).value;
  const t = parseNum(val('f-total')), l = parseNum(val('f-liters'));
  let p = parseNum(val('f-price'));
  const odo = parseIntLoose(val('f-odo'));
  const date = val('f-date');
  const err = (m: string) => { $('f-err').textContent = m; $('f-err').hidden = false; };
  if (!(t > 0)) return err('Informe o valor total pago.');
  if (!(l > 0)) return err('Informe os litros, ou o preço por litro.');
  if (!(odo > 0)) return err('Informe o odômetro.');
  if (!date) return err('Informe a data.');
  if (!(p > 0)) p = t / l;
  const others = carLogs().filter((f) => !editing || f.id !== editing.id);
  const before = others.filter((f) => f.date < date || (f.date === date && f.odometer_km < odo)).pop();
  if (before && odo <= before.odometer_km) return err('O odômetro precisa ser maior que ' + km(before.odometer_km) + ' km (registro de ' + dm(before.date) + ').');
  const after = others.find((f) => f.date > date);
  if (after && odo >= after.odometer_km) return err('O odômetro precisa ser menor que ' + km(after.odometer_km) + ' km (registro de ' + dm(after.date) + ').');
  const rng = parseIntLoose(val('f-range'));
  const flex = v.fuel_type === 'flex';
  const fuel: FuelType = flex ? ($<HTMLInputElement>('f-fuel-e').checked ? 'etanol' : 'gasolina') : (v.fuel_type as FuelType);
  const row = stamp<FuelLog>({
    id: editing?.id ?? uuid(),
    vehicle_id: editing?.vehicle_id ?? v.id,
    date,
    odometer_km: odo,
    liters: Math.round(l * 1000) / 1000,
    total_brl: Math.round(t * 100) / 100,
    price_per_l: Math.round(p * 1000) / 1000,
    fuel,
    full_tank: $<HTMLInputElement>('f-full').checked,
    range_left_km: Number.isFinite(rng) ? rng : null,
    station: val('f-station').trim().slice(0, 80) || null,
    station_id: fillStation && val('f-station').trim() === fillStation.name ? fillStation.id : null,
    note: val('f-note').trim().slice(0, 140) || null,
  });
  const wasEdit = !!editing;
  await db.fuel_logs.put(row);
  closeSheets();
  if (!wasEdit) show('inicio');
  toast(wasEdit ? 'Alterações salvas' : 'Abastecimento salvo');
});

/* ---------- carros ---------- */
function openCars() {
  if (!activeVehicles().length) return openVehicle(null);
  const cur = current();
  $('car-list').innerHTML = activeVehicles()
    .map((v) => {
      const sub = [v.make, v.model, v.year, v.engine].filter(Boolean).join(' · ');
      return '<div class="car-row' + (cur && v.id === cur.id ? ' current' : '') + '"><button type="button" class="car-pick" data-pick="' + esc(v.id) + '"><span class="radio"></span><span><div class="nm">' + esc(v.name) + '</div><div class="sub">' + esc(sub || 'Sem detalhes') + '</div></span></button><button type="button" class="link-btn" data-edit="' + esc(v.id) + '">Editar</button></div>';
    })
    .join('');
  openSheet('car-sheet');
}
$('car-btn').addEventListener('click', openCars);
$('car-list').addEventListener('click', async (e) => {
  const el = e.target as HTMLElement;
  const edit = el.closest<HTMLElement>('[data-edit]');
  const pick = el.closest<HTMLElement>('[data-pick]');
  if (edit) return openVehicle(edit.dataset.edit!);
  if (pick) {
    await setMeta('current_vehicle', pick.dataset.pick);
    closeSheets();
  }
});
$('car-add').addEventListener('click', () => openVehicle(null));

let editingVehicle: Vehicle | null = null;
let archArmed = false;
function openVehicle(id: string | null) {
  editingVehicle = id ? S.vehicles.find((v) => v.id === id) ?? null : null;
  archArmed = false;
  const ev = editingVehicle;
  $('vehicle-title').textContent = ev ? 'Editar carro' : 'Cadastrar carro';
  const set = (i: string, val: unknown) => ($<HTMLInputElement>(i).value = val == null ? '' : String(val));
  set('v-name', ev?.name);
  set('v-make', ev?.make);
  set('v-model', ev?.model);
  set('v-year', ev?.year);
  set('v-engine', ev?.engine);
  set('v-fuel', ev?.fuel_type ?? 'flex');
  set('v-km', ev?.initial_km);
  $('v-err').hidden = true;
  const arch = $('v-archive');
  arch.hidden = !ev;
  arch.classList.remove('armed');
  arch.textContent = 'Arquivar carro';
  openSheet('vehicle-sheet');
  setTimeout(() => $('v-name').focus({ preventScroll: true }), 260);
}
$('v-archive').addEventListener('click', async () => {
  if (!editingVehicle) return;
  if (!archArmed) {
    archArmed = true;
    $('v-archive').classList.add('armed');
    $('v-archive').textContent = 'Confirmar: arquivar ' + editingVehicle.name;
    return;
  }
  await db.vehicles.put(stamp<Vehicle>({ ...editingVehicle, archived: 1 }));
  closeSheets();
  toast(editingVehicle.name + ' arquivado; o histórico continua guardado.');
});
$('vehicle-sheet').addEventListener('submit', async (e) => {
  e.preventDefault();
  const val = (i: string) => $<HTMLInputElement>(i).value.trim();
  const name = val('v-name').slice(0, 40);
  if (!name) {
    $('v-err').textContent = 'Dê um apelido ao carro, por exemplo "Creta".';
    $('v-err').hidden = false;
    return;
  }
  const year = parseIntLoose(val('v-year'));
  const ikm = parseIntLoose(val('v-km'));
  const row = stamp<Vehicle>({
    id: editingVehicle?.id ?? uuid(),
    name,
    make: val('v-make') || null,
    model: val('v-model') || null,
    year: Number.isFinite(year) ? year : null,
    engine: val('v-engine') || null,
    fuel_type: val('v-fuel') as VehicleFuel,
    initial_km: Number.isFinite(ikm) ? ikm : null,
    plan_key: editingVehicle?.plan_key ?? null,
    archived: 0,
  });
  await db.vehicles.put(row);
  if (!editingVehicle) await setMeta('current_vehicle', row.id);
  closeSheets();
  toast(editingVehicle ? 'Carro atualizado' : name + ' cadastrado');
});

/* ---------- conta, backup e aparelho ---------- */
async function renderSettings() {
  // Excluídos continuam na base como marcação (deleted_at) até a sincronização; não entram na contagem
  const live = (t: any) => t.filter((r: { deleted_at: string | null }) => !r.deleted_at).count();
  const [v, f, s, i] = await Promise.all([live(db.vehicles), live(db.fuel_logs), live(db.services), live(db.service_items)]);
  $('count-d').textContent = pl(v, 'carro', 'carros') + ' · ' + pl(f, 'abastecimento', 'abastecimentos') + ' · ' + pl(s, 'manutenção', 'manutenções') + ' (' + pl(i, 'item', 'itens') + ')';
  $('ver-d').textContent = 'Build ' + __BUILD__;
  let persisted = false;
  try { persisted = (await navigator.storage?.persisted?.()) ?? false; } catch { /* sem suporte */ }
  const signedIn = !!(await currentSession());
  $('persist-d').textContent = persisted
    ? 'Sim: o Android não apaga estes dados para liberar espaço'
    : signedIn
      ? 'Não confirmado, mas seus dados também ficam na nuvem'
      : 'Não confirmado: entre na conta para ter cópia na nuvem, ou exporte backups';
}
function openSettings() {
  renderSettings();
  renderAccount();
  openSheet('set-sheet');
}
$('sync').addEventListener('click', openSettings);

let syncStatus: SyncStatus = { kind: 'signed-out' };
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
function syncText(): [string, string] {
  const n = S.pending;
  switch (syncStatus.kind) {
    case 'signed-out': return ['', 'Salvo só neste aparelho'];
    case 'offline': return ['wait', n ? 'Sem internet · ' + n + ' a enviar' : 'Sem internet'];
    case 'syncing': return ['wait', 'Sincronizando…'];
    case 'ok': return n ? ['wait', n + ' a enviar'] : ['on', 'Sincronizado às ' + hhmm(syncStatus.at)];
    case 'error': return ['err', 'Sincronização falhou'];
  }
}
function renderSync() {
  const [cls, txt] = syncText();
  const el = $('sync');
  el.className = 'sync ' + cls;
  el.lastElementChild!.textContent = txt;
  if (view === 'mais') renderMais(current());
  if (document.getElementById('acct-status')) renderAccount();
}
onSyncStatus((st) => {
  syncStatus = st;
  renderSync();
});

let otpEmail = '';
let otpSent = false;
async function renderAccount() {
  const box = $('acct');
  const session = await currentSession();
  if (session) {
    const detail = syncStatus.kind === 'error' ? syncStatus.message : syncText()[1];
    box.innerHTML =
      '<div class="set-row"><div><div class="t">' + esc(session.user.email) + '</div><div class="d" id="acct-status">' + esc(detail) + '</div></div><button type="button" class="link-btn" id="a-sync">Sincronizar</button></div>' +
      '<div class="set-row"><div><div class="t">Sair desta conta</div><div class="d">Os dados continuam neste aparelho</div></div><button type="button" class="link-btn" id="a-out">Sair</button></div>';
    return;
  }
  box.innerHTML = otpSent
    ? '<div class="set-row col"><div><div class="t">Confira seu e-mail</div><div class="d">Enviamos um link de acesso para <b>' + esc(otpEmail) + '</b>. Abra o e-mail <b>neste aparelho</b> e toque no link: o app abre já conectado. Pode levar um minuto e às vezes cai no spam.</div></div>' +
      '<label class="field">Se o e-mail trouxe um código numérico, digite aqui<input class="inp sm" id="a-code" inputmode="numeric" autocomplete="one-time-code" maxlength="8"></label>' +
      '<div class="err" id="a-err" hidden></div>' +
      '<div class="btn-row"><button type="button" class="btn" id="a-back">Trocar e-mail</button><button type="button" class="btn primary" id="a-go">Entrar com código</button></div></div>'
    : '<div class="set-row col"><div><div class="t">Entrar para sincronizar</div><div class="d">Seus dados vão para a nuvem e aparecem em qualquer aparelho. Sem senha: você recebe um link de acesso no e-mail.</div></div>' +
      '<label class="field">E-mail<input class="inp sm" id="a-email" type="email" inputmode="email" autocomplete="email" value="' + esc(otpEmail) + '"></label>' +
      '<div class="err" id="a-err" hidden></div>' +
      '<button type="button" class="btn primary" id="a-go">Enviar link de acesso</button></div>';
}
$('acct').addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
  const id = btn?.id;
  if (!btn || !id) return;
  const err = (m: string) => { const el = document.getElementById('a-err'); if (el) { el.textContent = m; el.hidden = false; } };
  if (id === 'a-sync') { await sync(); return renderAccount(); }
  if (id === 'a-out') { await signOut(); toast('Você saiu. Os dados continuam neste aparelho.'); return renderAccount(); }
  if (id === 'a-back') { otpSent = false; return renderAccount(); }
  if (id === 'a-go') {
    if (navigator.onLine === false) return err('Sem internet. Conecte-se para entrar.');
    btn.disabled = true;
    try {
      if (!otpSent) {
        otpEmail = $<HTMLInputElement>('a-email').value.trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(otpEmail)) throw new Error('Digite um e-mail válido.');
        await sendLoginEmail(otpEmail);
        otpSent = true;
        toast('Link enviado para ' + otpEmail);
      } else {
        const code = $<HTMLInputElement>('a-code').value.replace(/\D/g, '');
        if (code.length < 6 || code.length > 8) throw new Error('Digite o código numérico que chegou no e-mail.');
        await verifyCode(otpEmail, code);
        otpSent = false;
        toast('Conta conectada. Sincronizando…');
        await sync();
      }
      renderAccount();
    } catch (ex) {
      err((ex as Error).message);
    } finally {
      btn.disabled = false;
    }
  }
});
$('exp-btn').addEventListener('click', async () => {
  const data = await exportBackup();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'caderneta-carro-backup-' + todayISO() + '.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('Backup exportado');
});
$('imp-btn').addEventListener('click', () => $<HTMLInputElement>('imp-file').click());
$<HTMLInputElement>('imp-file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const res = await importBackup(JSON.parse(await file.text()));
    if (!current()) {
      const first = (await db.vehicles.toArray()).find((v) => !v.archived && !v.deleted_at);
      if (first) await setMeta('current_vehicle', first.id);
    }
    closeSheets();
    toast('Importado: ' + pl(res.vehicles, 'carro', 'carros') + ', ' + pl(res.fuel_logs, 'abastecimento', 'abastecimentos') + ', ' + pl(res.services, 'manutenção', 'manutenções'));
  } catch (err) {
    toast(err instanceof SyntaxError ? 'Arquivo inválido: não é um JSON.' : (err as Error).message);
  }
});

/* ---------- toast ---------- */
let toastTimer: number | undefined;
function toast(m: string) {
  const t = $('toast');
  t.classList.remove('sticky');
  t.textContent = m;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2600);
}
function stickyToast(m: string, label: string, action: () => void) {
  const t = $('toast');
  clearTimeout(toastTimer);
  t.innerHTML = '<span>' + esc(m) + '</span><button type="button">' + esc(label) + '</button>';
  t.classList.add('show', 'sticky');
  t.querySelector('button')!.addEventListener('click', action, { once: true });
}

/* ---------- PWA ---------- */
const updateSW = registerSW({
  onNeedRefresh() {
    stickyToast('Nova versão disponível', 'Atualizar', () => updateSW(true));
  },
  onOfflineReady() {
    toast('Pronto para usar sem internet');
  },
});
navigator.storage?.persist?.().catch(() => {});
startAutoSync();
show('inicio');

/* ---------- volta do link do e-mail ---------- */
{
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('error_code') || hash.get('error')) {
    const expired = /expired|invalid/i.test(hash.get('error_code') + ' ' + hash.get('error_description'));
    history.replaceState(null, '', location.pathname);
    setTimeout(() => toast(expired ? 'O link expirou ou já foi usado. Peça outro em Mais › Conta.' : 'Não foi possível entrar pelo link. Tente de novo.'), 600);
  } else if (hash.get('access_token')) {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') {
        otpSent = false;
        toast('Conta conectada. Sincronizando…');
        data.subscription.unsubscribe();
      }
    });
  }
}
