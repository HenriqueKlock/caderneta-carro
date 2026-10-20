import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-500.css';
import '@fontsource/barlow/latin-600.css';
import '@fontsource/barlow-condensed/latin-500.css';
import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import './styles.css';

import { liveQuery } from 'dexie';
import { registerSW } from 'virtual:pwa-register';
import { db, getMeta, setMeta, softDelete, stamp, uuid, type FuelLog, type FuelType, type PendingFile, type Service, type ServiceItem, type Vehicle, type VehicleFuel } from './db';
import { initMaintenance, currentKmOf } from './manut';
import { maintenanceTotals } from './maintenance';
import { aggregate, intervals, kmPerDay, parseIntLoose, parseNum, sortLogs, type Interval } from './calc';
import { exportBackup, importBackup } from './backup';
import { currentSession, onSyncStatus, scheduleSync, sendLoginEmail, signOut, startAutoSync, supabase, sync, verifyCode, type SyncStatus } from './sync';

declare const __BUILD__: string;

/* ---------- helpers ---------- */
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
const brl = (n: number) => 'R$ ' + fmt(n, 2);
const km = (n: number) => (Number.isFinite(n) ? Math.round(n).toLocaleString('pt-BR') : '–');
const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const dm = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
const pl = (n: number, one: string, many: string) => n + ' ' + (n === 1 ? one : many);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

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
}
let S: State = { vehicles: [], logs: [], currentId: null, calc: { gas: '', eth: '', ratio: 0.7 }, pending: 0, services: [], items: [], files: [] };

const activeVehicles = () => S.vehicles.filter((v) => !v.archived).sort((a, b) => a.name.localeCompare(b.name));
const current = (): Vehicle | undefined => S.vehicles.find((v) => v.id === S.currentId && !v.archived) ?? activeVehicles()[0];
const carLogs = (): FuelLog[] => {
  const v = current();
  return v ? sortLogs(S.logs.filter((f) => f.vehicle_id === v.id)) : [];
};

const maint = initMaintenance({ $, fmt, brl, km, esc, pl, todayISO, toast, openSheet, closeSheets, parseNum, parseIntLoose });

liveQuery(async () => {
  const [vehicles, logs, currentId, calc, dirty, services, items, files] = await Promise.all([
    db.vehicles.toArray(),
    db.fuel_logs.toArray(),
    getMeta<string | null>('current_vehicle', null),
    getMeta<CalcCfg>('calc', { gas: '', eth: '', ratio: 0.7 }),
    Promise.all([db.vehicles, db.fuel_logs, db.services, db.service_items].map((t: any) => t.where('_dirty').equals(1).count())),
    db.services.toArray(),
    db.service_items.toArray(),
    db.pending_files.toArray(),
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
function render() {
  const v = current();
  const fs = carLogs();
  const iv = intervals(fs);
  const all = aggregate(iv);
  $('car-name').textContent = v ? v.name : 'Cadastrar carro';
  const last = fs[fs.length - 1];
  const odoVal = currentKmOf(v, fs, S.services);
  $('odo').innerHTML = [...String(odoVal).padStart(6, '0')].map((c) => '<span>' + c + '</span>').join('');
  $('last-fill').innerHTML = last ? 'Último: <b>' + dm(last.date) + '</b><br>' + fmt(last.liters, 2) + ' l · ' + brl(last.total_brl) : v ? 'Sem abastecimentos' : '';
  renderPainel(v, fs, iv, all);
  renderHist(fs, iv);
  renderCalc(v, fs, iv);
  maint.render({ vehicle: v, logs: fs, services: S.services, items: S.items, pending: S.files });
}

function renderPainel(v: Vehicle | undefined, fs: FuelLog[], iv: Interval[], all: ReturnType<typeof aggregate>) {
  const charts = [$('card-kml'), $('card-price')];
  if (!v) {
    $('h-avg').textContent = '–';
    $('h-sub').innerHTML = 'Cadastre seu carro ou importe um backup para começar.';
    $('kpis').innerHTML =
      '<div class="kpi" style="grid-column:1/-1"><div class="empty" style="padding:12px"><div class="actions" style="width:100%"><button class="btn primary" type="button" id="e-add-car">Cadastrar carro</button><button class="btn" type="button" id="e-import">Importar backup</button></div></div></div>';
    $('kpis').hidden = false;
    $('e-add-car').onclick = () => openVehicle(null);
    $('e-import').onclick = () => $<HTMLInputElement>('imp-file').click();
    charts.forEach((c) => (c.hidden = true));
    return;
  }
  if (!iv.length) {
    $('h-avg').textContent = '–';
    $('h-sub').textContent = fs.length ? 'Registre mais um tanque cheio para calcular o consumo.' : 'Toque em + para registrar o primeiro abastecimento.';
    $('kpis').innerHTML = '';
    $('kpis').hidden = true;
    charts.forEach((c) => (c.hidden = true));
    return;
  }
  $('kpis').hidden = false;
  charts.forEach((c) => (c.hidden = false));
  $('h-avg').textContent = fmt(all.kml, 2);
  const l3 = aggregate(iv.slice(-3));
  const lastIv = iv[iv.length - 1];
  $('h-sub').innerHTML = '<b>' + km(all.km) + ' km</b> em ' + all.n + (all.n > 1 ? ' tanques' : ' tanque') + ' · últimos 3: <b>' + fmt(l3.kml, 2) + '</b> · último: <b>' + fmt(lastIv.kml, 2) + '</b>';
  const kd = kmPerDay(fs);
  const cut = new Date(todayISO() + 'T12:00:00');
  cut.setDate(cut.getDate() - 30);
  const cutISO = cut.toISOString().slice(0, 10);
  const recent = fs.filter((f) => f.date >= cutISO);
  const spent30 = recent.reduce((s, f) => s + f.total_brl, 0);
  const totL = fs.reduce((s, f) => s + f.liters, 0);
  const totC = fs.reduce((s, f) => s + f.total_brl, 0);
  const best = iv.reduce((a, b) => (b.kml > a.kml ? b : a));
  const worst = iv.reduce((a, b) => (b.kml < a.kml ? b : a));
  const kpis: [string, string, string][] = [
    ['Custo por km', brl(all.rpk), 'só combustível'],
    ['Gasto 30 dias', brl(spent30), recent.length + (recent.length === 1 ? ' abastecimento' : ' abastecimentos')],
    ['Rodagem', Number.isFinite(kd) ? km(kd * 30) + ' km/mês' : '–', Number.isFinite(kd) ? fmt(kd, 0) + ' km/dia · ≈ ' + brl(kd * 30 * all.rpk) + '/mês' : ''],
    ['Preço médio pago', brl(totC / totL) + '/l', fmt(totL, 1) + ' l no total'],
    ['Melhor tanque', fmt(best.kml, 2) + ' km/l', dm(best.date) + ' · ' + km(best.km) + ' km'],
    ['Pior tanque', fmt(worst.kml, 2) + ' km/l', dm(worst.date) + ' · ' + km(worst.km) + ' km'],
  ];
  const y1 = new Date(todayISO() + 'T12:00:00Z');
  y1.setUTCFullYear(y1.getUTCFullYear() - 1);
  const m12 = maintenanceTotals(v.id, S.services, S.items, y1.toISOString().slice(0, 10));
  const mSpan = maintenanceTotals(v.id, S.services, S.items, fs[0].date);
  kpis.push(
    ['Manutenção 12 meses', brl(m12.total), pl(m12.visits, 'ida à oficina', 'idas à oficina')],
    ['Custo total por km', brl((all.cost + mSpan.total) / all.km), 'combustível + manutenção desde ' + dm(fs[0].date)],
  );
  $('kpis').innerHTML = kpis.map((k) => '<div class="kpi"><span class="k">' + k[0] + '</span><span class="v num">' + k[1] + '</span><span class="s">' + k[2] + '</span></div>').join('');
  $('chart-kml').innerHTML = barChart(iv, all.kml);
  $('avg-legend').textContent = 'média ' + fmt(all.kml, 2);
  const pr = fs.map((f) => ({ date: f.date, p: f.price_per_l || f.total_brl / f.liters, fuel: f.fuel }));
  const ps = pr.map((x) => x.p);
  $('price-range').textContent = brl(Math.min(...ps)) + ' – ' + brl(Math.max(...ps));
  $('chart-price').innerHTML = lineChart(pr);
}

function barChart(iv: Interval[], avg: number) {
  const W = 340, H = 170, pl = 4, pr = 4, pt = 20, pb = 22;
  const data = iv.slice(-10);
  const max = Math.max(...data.map((d) => d.kml), avg) * 1.12;
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / max);
  const bw = (W - pl - pr) / data.length;
  const g = Math.min(bw * 0.28, 14);
  let s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Consumo por tanque">';
  s += '<line x1="0" x2="' + W + '" y1="' + (H - pb) + '" y2="' + (H - pb) + '" stroke="var(--line)"/>';
  data.forEach((d, i) => {
    const x = pl + i * bw + g / 2, w = bw - g, yy = y(d.kml);
    const col = d.fuel === 'etanol' ? 'var(--eth)' : d.fuel === 'misto' ? 'var(--muted)' : 'var(--gas)';
    s += '<rect x="' + x.toFixed(1) + '" y="' + yy.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + (H - pb - yy).toFixed(1) + '" rx="3" fill="' + col + '" opacity="' + (i === data.length - 1 ? 1 : 0.72) + '"/>';
    s += '<text class="val" x="' + (x + w / 2).toFixed(1) + '" y="' + (yy - 5).toFixed(1) + '" text-anchor="middle">' + fmt(d.kml, 1) + '</text>';
    s += '<text x="' + (x + w / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + dm(d.date) + '</text>';
  });
  const ya = y(avg);
  s += '<line x1="0" x2="' + W + '" y1="' + ya.toFixed(1) + '" y2="' + ya.toFixed(1) + '" stroke="var(--ink)" stroke-dasharray="4 4" stroke-width="1" opacity=".55"/>';
  return s + '</svg>';
}

function lineChart(pr: { date: string; p: number; fuel: FuelType }[]) {
  const W = 340, H = 110, pl = 6, prr = 6, pt = 18, pb = 20;
  const data = pr.slice(-12);
  if (data.length < 2) return '';
  const vs = data.map((d) => d.p);
  let mn = Math.min(...vs), mx = Math.max(...vs);
  const pad = (mx - mn) * 0.25 || 0.1;
  mn -= pad; mx += pad;
  const x = (i: number) => pl + ((W - pl - prr) * i) / (data.length - 1);
  const y = (v: number) => pt + (H - pt - pb) * (1 - (v - mn) / (mx - mn));
  const pts = data.map((d, i) => x(i).toFixed(1) + ',' + y(d.p).toFixed(1));
  let s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Preço por litro">';
  s += '<polygon points="' + x(0).toFixed(1) + ',' + (H - pb) + ' ' + pts.join(' ') + ' ' + x(data.length - 1).toFixed(1) + ',' + (H - pb) + '" fill="var(--accent)" opacity=".12"/>';
  s += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>';
  data.forEach((d, i) => {
    const last = i === data.length - 1;
    s += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(d.p).toFixed(1) + '" r="' + (last ? 4 : 2.5) + '" fill="' + (d.fuel === 'etanol' ? 'var(--eth)' : 'var(--accent)') + '"/>';
    s += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 5) + '" text-anchor="' + (i === 0 ? 'start' : last ? 'end' : 'middle') + '">' + dm(d.date) + '</text>';
    if (last || i === 0) s += '<text class="val" x="' + x(i).toFixed(1) + '" y="' + (y(d.p) - 8).toFixed(1) + '" text-anchor="' + (i === 0 ? 'start' : 'end') + '">' + fmt(d.p, 2) + '</text>';
  });
  return s + '</svg>';
}

function renderHist(fs: FuelLog[], iv: Interval[]) {
  const byId = Object.fromEntries(iv.map((x) => [x.id, x]));
  $('hist-count').textContent = fs.length + (fs.length === 1 ? ' registro' : ' registros');
  if (!fs.length) {
    $('hist').innerHTML = '<div class="empty">Nenhum abastecimento ainda.</div>';
    return;
  }
  $('hist').innerHTML = fs
    .slice()
    .reverse()
    .map((f) => {
      const [y, m, d] = f.date.split('-');
      const i = byId[f.id];
      const price = f.price_per_l || f.total_brl / f.liters;
      const b = [km(f.odometer_km) + ' km', f.range_left_km != null ? 'restavam ' + f.range_left_km + ' km' : '', f.station ? esc(f.station) : '', f.note ? esc(f.note) : ''].filter(Boolean).join(' · ');
      return (
        '<button type="button" class="row" data-id="' + esc(f.id) + '"><span class="r-date num">' + d + '/' + m + '<small>' + MES[+m - 1] + ' ' + y.slice(2) + '</small></span>' +
        '<span class="r-mid"><span class="a num">' + brl(f.total_brl) + ' · ' + fmt(f.liters, 2) + ' l</span><span class="b num">R$ ' + fmt(price, 2) + '/l · ' + b + '</span></span>' +
        '<span class="r-end">' + (i ? '<span class="kml num">' + fmt(i.kml, 2) + ' <small>km/l</small></span>' : '<span class="note">–</span>') +
        (f.full_tank ? '<span class="pill ' + f.fuel + '">' + f.fuel + '</span>' : '<span class="pill part">parcial</span>') + '</span></button>'
      );
    })
    .join('');
}

function renderCalc(v: Vehicle | undefined, fs: FuelLog[], iv: Interval[]) {
  const c = S.calc;
  const lastGas = [...fs].reverse().find((f) => f.fuel === 'gasolina');
  const gasDefault = lastGas ? lastGas.price_per_l || lastGas.total_brl / lastGas.liters : NaN;
  const gasEl = $<HTMLInputElement>('c-gas'), ethEl = $<HTMLInputElement>('c-eth'), rEl = $<HTMLInputElement>('c-ratio');
  if (document.activeElement !== gasEl) gasEl.value = c.gas || '';
  if (document.activeElement !== ethEl) ethEl.value = c.eth || '';
  if (Number.isFinite(gasDefault)) gasEl.placeholder = fmt(gasDefault, 2);
  const g = aggregate(iv.filter((x) => x.fuel === 'gasolina'));
  const e = aggregate(iv.filter((x) => x.fuel === 'etanol'));
  let ratio = Number(c.ratio) || 0.7;
  let hint: string;
  if (g.n && e.n) {
    ratio = e.kml / g.kml;
    hint = 'Medido neste carro: ' + fmt(e.kml, 2) + ' km/l no etanol vs ' + fmt(g.kml, 2) + ' na gasolina.';
    rEl.disabled = true;
  } else {
    rEl.disabled = false;
    hint = 'Estimativa pela regra dos 70%. Quando você registrar tanques de etanol, o app passa a usar o rendimento real.';
  }
  if (v && v.fuel_type !== 'flex') hint = 'Este carro não é flex; a comparação serve só como referência.';
  if (document.activeElement !== rEl) rEl.value = ratio.toFixed(2);
  $('c-ratio-out').textContent = Math.round(ratio * 100) + '%';
  $('c-ratio-hint').textContent = hint;
  const gas = Number.isFinite(parseNum(c.gas)) ? parseNum(c.gas) : gasDefault;
  const eth = parseNum(c.eth);
  const kmlG = g.n ? g.kml : NaN;
  const kmlE = e.n ? e.kml : kmlG * ratio;
  $('c-thr').textContent = Number.isFinite(gas) ? brl(gas * ratio) : '–';
  $('c-thr-sub').textContent = Number.isFinite(gas) ? 'com gasolina a ' + brl(gas) + ' · ' + Math.round(ratio * 100) + '%' : 'informe o preço da gasolina';
  const box = $('c-verdict');
  if (!Number.isFinite(gas) || !Number.isFinite(eth)) {
    box.className = 'verdict';
    box.innerHTML = '<span class="note">Digite o preço do etanol no posto para ver qual compensa.</span>';
    return;
  }
  const pct = eth / gas;
  const ethWins = pct < ratio;
  const rpkG = gas / kmlG, rpkE = eth / kmlE;
  const kd = kmPerDay(fs);
  const kmMonth = kd * 30;
  const diffM = Math.abs(rpkG - rpkE) * kmMonth;
  box.className = 'verdict ' + (ethWins ? 'eth' : 'gas');
  box.innerHTML =
    '<span class="sec-label">Etanol custa ' + fmt(pct * 100, 1) + '% da gasolina</span><span class="big">' + (ethWins ? 'Vá de etanol' : 'Fique na gasolina') + '</span>' +
    (Number.isFinite(rpkG) ? '<div class="cmp"><div><div class="k">Gasolina</div><div class="v num">' + brl(rpkG) + '/km</div><div class="k">' + fmt(kmlG, 2) + ' km/l</div></div><div><div class="k">Etanol</div><div class="v num">' + brl(rpkE) + '/km</div><div class="k">' + fmt(kmlE, 2) + ' km/l' + (e.n ? '' : ' (est.)') + '</div></div></div>' : '') +
    (Number.isFinite(diffM) ? '<span class="note">Diferença de ≈ ' + brl(diffM) + ' por mês no seu ritmo de ' + km(kmMonth) + ' km.</span>' : '');
}

/* ---------- navegação ---------- */
function show(view: string) {
  document.querySelectorAll<HTMLElement>('.view').forEach((s) => (s.hidden = s.id !== 'v-' + view));
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String((t as HTMLElement).dataset.view === view)));
  window.scrollTo(0, 0);
}
document.querySelectorAll<HTMLElement>('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.view!)));

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
let delArmed = false;
let recent: string[] = [];

function openFill(id: string | null) {
  const v = current();
  if (!v) {
    toast('Cadastre o carro primeiro.');
    openVehicle(null);
    return;
  }
  editing = id ? S.logs.find((f) => f.id === id) ?? null : null;
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
  const set = (id: string, val: string) => ($<HTMLInputElement>(id).value = val);
  set('f-date', editing?.date ?? todayISO());
  set('f-total', editing ? fmt(editing.total_brl, 2) : '');
  set('f-liters', editing ? fmt(editing.liters, editing.liters % 1 && String(editing.liters).split('.')[1]?.length > 2 ? 3 : 2) : '');
  set('f-price', editing ? fmt(editing.price_per_l, 3).replace(/0$/, '') : '');
  set('f-odo', editing ? String(editing.odometer_km) : '');
  set('f-range', editing?.range_left_km != null ? String(editing.range_left_km) : '');
  set('f-station', editing?.station ?? '');
  set('f-note', editing?.note ?? '');
  $<HTMLInputElement>('f-full').checked = editing ? editing.full_tank : true;
  $<HTMLInputElement>(fuel === 'etanol' ? 'f-fuel-e' : 'f-fuel-g').checked = true;
  $<HTMLInputElement>('f-odo').placeholder = last ? String(last.odometer_km + 380) : v.initial_km ? String(v.initial_km) : '';
  if (last?.station && !editing) $<HTMLInputElement>('f-station').placeholder = last.station;
  $('f-hint').textContent = last && !editing ? 'Último odômetro: ' + km(last.odometer_km) + ' km. Preencha dois entre valor, litros e preço.' : 'Preencha dois entre valor, litros e preço; o terceiro é calculado.';
  recent = editing ? ['total', 'liters'] : [];
  ['total', 'liters', 'price'].forEach((k) => $('f-' + k).classList.remove('auto'));
  openSheet('fill-sheet');
  if (!editing) setTimeout(() => $('f-total').focus({ preventScroll: true }), 260);
}
$('add-btn').addEventListener('click', () => openFill(null));
$('hist').addEventListener('click', (e) => {
  const r = (e.target as HTMLElement).closest<HTMLElement>('.row');
  if (r) openFill(r.dataset.id!);
});

(['total', 'liters', 'price'] as const).forEach((k) =>
  $('f-' + k).addEventListener('input', () => {
    recent = recent.filter((x) => x !== k);
    recent.push(k);
    if (recent.length > 2) recent.shift();
    $('f-' + k).classList.remove('auto');
    if (recent.length < 2) return;
    const target = (['total', 'liters', 'price'] as const).find((x) => !recent.includes(x))!;
    const t = parseNum($<HTMLInputElement>('f-total').value), l = parseNum($<HTMLInputElement>('f-liters').value), p = parseNum($<HTMLInputElement>('f-price').value);
    let v = NaN, d = 2;
    if (target === 'price' && t > 0 && l > 0) { v = t / l; d = 3; }
    else if (target === 'total' && l > 0 && p > 0) v = l * p;
    else if (target === 'liters' && t > 0 && p > 0) { v = t / p; d = 3; }
    if (Number.isFinite(v)) {
      $<HTMLInputElement>('f-' + target).value = fmt(v, d);
      $('f-' + target).classList.add('auto');
    }
  }),
);

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
    note: val('f-note').trim().slice(0, 140) || null,
  });
  const wasEdit = !!editing;
  await db.fuel_logs.put(row);
  closeSheets();
  if (!wasEdit) show('painel');
  toast(wasEdit ? 'Alterações salvas' : 'Abastecimento salvo');
});

/* ---------- carros ---------- */
function renderCars() {
  const cur = current();
  const list = activeVehicles();
  $('car-list').innerHTML = list.length
    ? list
        .map((v) => {
          const sub = [v.make, v.model, v.year, v.engine].filter(Boolean).join(' · ');
          return '<div class="car-row' + (cur && v.id === cur.id ? ' current' : '') + '"><button type="button" class="car-pick" data-pick="' + esc(v.id) + '"><span class="radio"></span><span><div class="nm">' + esc(v.name) + '</div><div class="sub">' + esc(sub || 'Sem detalhes') + '</div></span></button><button type="button" class="link-btn" data-edit="' + esc(v.id) + '">Editar</button></div>';
        })
        .join('')
    : '<div class="empty">Nenhum carro cadastrado.</div>';
}
$('car-btn').addEventListener('click', () => {
  if (!activeVehicles().length) return openVehicle(null);
  renderCars();
  openSheet('car-sheet');
});
$('car-list').addEventListener('click', async (e) => {
  const el = e.target as HTMLElement;
  const pick = el.closest<HTMLElement>('[data-pick]');
  const edit = el.closest<HTMLElement>('[data-edit]');
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
  arch.textContent = 'Arquivar';
  openSheet('vehicle-sheet');
  setTimeout(() => $('v-name').focus({ preventScroll: true }), 260);
}
$('v-archive').addEventListener('click', async () => {
  if (!editingVehicle) return;
  if (!archArmed) {
    archArmed = true;
    $('v-archive').classList.add('armed');
    $('v-archive').textContent = 'Confirmar';
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

/* ---------- calculadora ---------- */
let calcTimer: number | undefined;
function saveCalc(patch: Partial<CalcCfg>) {
  S.calc = { ...S.calc, ...patch };
  renderCalc(current(), carLogs(), intervals(carLogs()));
  clearTimeout(calcTimer);
  calcTimer = window.setTimeout(() => setMeta('calc', S.calc), 400);
}
$('c-gas').addEventListener('input', (e) => saveCalc({ gas: (e.target as HTMLInputElement).value }));
$('c-eth').addEventListener('input', (e) => saveCalc({ eth: (e.target as HTMLInputElement).value }));
$('c-ratio').addEventListener('input', (e) => saveCalc({ ratio: Number((e.target as HTMLInputElement).value) }));

/* ---------- ajustes e backup ---------- */
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
$('set-btn').addEventListener('click', () => {
  renderSettings();
  renderAccount();
  openSheet('set-sheet');
});
$('sync').addEventListener('click', () => $('set-btn').click());

/* ---------- conta e sincronização ---------- */
let syncStatus: SyncStatus = { kind: 'signed-out' };
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
function syncText(): [string, string] {
  const n = S.pending;
  switch (syncStatus.kind) {
    case 'signed-out': return ['', 'Salvo só neste aparelho'];
    case 'offline': return ['wait', n ? 'Sem internet · ' + n + ' a enviar' : 'Sem internet · dados no aparelho'];
    case 'syncing': return ['wait', 'Sincronizando…'];
    case 'ok': return n ? ['wait', n + ' a enviar'] : ['on', 'Sincronizado às ' + hhmm(syncStatus.at)];
    case 'error': return ['err', 'Sincronização falhou · toque para ver'];
  }
}
function renderSync() {
  const [cls, txt] = syncText();
  const el = $('sync');
  el.className = 'sync ' + cls;
  el.lastElementChild!.textContent = txt;
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
      '<div class="field"><label for="a-code">Se o e-mail trouxe um código numérico, digite aqui</label><input class="inp" id="a-code" inputmode="numeric" autocomplete="one-time-code" maxlength="8"></div>' +
      '<div class="err" id="a-err" hidden></div>' +
      '<div class="actions"><button type="button" class="btn ghost" id="a-back">Trocar e-mail</button><button type="button" class="btn primary" id="a-go">Entrar com código</button></div></div>'
    : '<div class="set-row col"><div><div class="t">Entrar para sincronizar</div><div class="d">Seus dados vão para a nuvem e aparecem em qualquer aparelho. Sem senha: você recebe um link de acesso no e-mail.</div></div>' +
      '<div class="field"><label for="a-email">E-mail</label><input class="inp sm" id="a-email" type="email" inputmode="email" autocomplete="email" value="' + esc(otpEmail) + '"></div>' +
      '<div class="err" id="a-err" hidden></div>' +
      '<div class="actions"><button type="button" class="btn primary" id="a-go">Enviar link de acesso</button></div></div>';
}
$('acct').addEventListener('click', async (e) => {
  const id = (e.target as HTMLElement).closest('button')?.id;
  if (!id) return;
  const err = (m: string) => { const el = document.getElementById('a-err'); if (el) { el.textContent = m; el.hidden = false; } };
  const btn = e.target as HTMLButtonElement;
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

/* ---------- volta do link do e-mail ---------- */
{
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('error_code') || hash.get('error')) {
    const expired = /expired|invalid/i.test(hash.get('error_code') + ' ' + hash.get('error_description'));
    history.replaceState(null, '', location.pathname);
    setTimeout(() => toast(expired ? 'O link expirou ou já foi usado. Peça outro na engrenagem.' : 'Não foi possível entrar pelo link. Tente de novo.'), 600);
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
