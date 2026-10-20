import type { FuelLog } from './db';
import { aggregate, intervals, kmPerDay, type Interval } from './calc.ts';
import { maintenanceTotals, type SvcItemLike, type SvcLike } from './maintenance.ts';

/** Indicadores que podem ir para o Início. O consumo médio é fixo e não entra aqui. */
export const CATALOG = [
  { id: 'gasto_mes', name: 'Gasto no mês' },
  { id: 'km_mes', name: 'Km rodados no mês' },
  { id: 'preco_gasolina', name: 'Preço médio da gasolina' },
  { id: 'ult3', name: 'Consumo dos últimos 3 tanques' },
  { id: 'km_mes_media', name: 'Média de km por mês' },
  { id: 'custo_km', name: 'Custo de combustível por km' },
  { id: 'custo_total_km', name: 'Custo total por km' },
  { id: 'manut_12m', name: 'Manutenção em 12 meses' },
  { id: 'extremos', name: 'Melhor e pior tanque' },
] as const;
export type IndicatorId = (typeof CATALOG)[number]['id'];
export const DEFAULT_HOME: IndicatorId[] = ['gasto_mes', 'km_mes'];
export const isIndicatorId = (s: unknown): s is IndicatorId => CATALOG.some((c) => c.id === s);

export interface IndValue {
  id: IndicatorId;
  name: string;
  value: string;
  sub: string;
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MES_CURTO = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export const monthKey = (iso: string) => iso.slice(0, 7);
export const monthName = (key: string) => MESES[+key.slice(5, 7) - 1];
export const monthShort = (key: string) => MES_CURTO[+key.slice(5, 7) - 1];

const nf = (n: number, d: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const brl = (n: number) => (Number.isFinite(n) ? 'R$ ' + nf(n, 2) : '–');
const kmTxt = (n: number) => (Number.isFinite(n) ? Math.round(n).toLocaleString('pt-BR') + ' km' : '–');
const pl = (n: number, one: string, many: string) => n + ' ' + (n === 1 ? one : many);
const dm = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7);

export interface IndInput {
  vehicleId: string;
  logs: FuelLog[]; // do carro, ordenados por odômetro
  services: SvcLike[];
  items: SvcItemLike[];
  today: string; // YYYY-MM-DD
}

/** Km rodados num mês: último odômetro do mês menos o último antes dele (abastecimentos e manutenções). */
export function kmInMonth(input: IndInput, key: string): { km: number; lastDate: string | null } {
  const pts = [
    ...input.logs.map((f) => ({ date: f.date, odo: f.odometer_km })),
    ...input.services.filter((s) => !s.deleted_at && s.vehicle_id === input.vehicleId && s.odometer_km != null).map((s) => ({ date: s.date, odo: s.odometer_km! })),
  ];
  const inMonth = pts.filter((p) => monthKey(p.date) === key);
  if (!inMonth.length) return { km: 0, lastDate: null };
  const before = pts.filter((p) => monthKey(p.date) < key);
  const end = Math.max(...inMonth.map((p) => p.odo));
  const start = before.length ? Math.max(...before.map((p) => p.odo)) : Math.min(...inMonth.map((p) => p.odo));
  const lastDate = inMonth.reduce((a, p) => (p.date > a ? p.date : a), inMonth[0].date);
  return { km: Math.max(0, end - start), lastDate };
}

function weightedPrice(logs: FuelLog[]): number {
  const l = logs.reduce((s, f) => s + f.liters, 0);
  return l ? logs.reduce((s, f) => s + f.total_brl, 0) / l : NaN;
}

export function computeIndicators(input: IndInput): Record<IndicatorId, IndValue> {
  const key = monthKey(input.today);
  const mes = monthName(key);
  const iv = intervals(input.logs);
  const all = aggregate(iv);
  const monthLogs = input.logs.filter((f) => monthKey(f.date) === key);
  const fuelMonth = monthLogs.reduce((s, f) => s + f.total_brl, 0);
  const maintMonth = maintenanceTotals(input.vehicleId, input.services, input.items, key + '-01');
  const maintThisMonth = input.services.filter((s) => !s.deleted_at && s.vehicle_id === input.vehicleId && monthKey(s.date) === key).length;
  const kmm = kmInMonth(input, key);
  const gas = input.logs.filter((f) => f.fuel === 'gasolina');
  const gasMonth = gas.filter((f) => monthKey(f.date) === key);
  const pGeral = weightedPrice(gas);
  const pMes = weightedPrice(gasMonth);
  const l3 = aggregate(iv.slice(-3));
  const kd = kmPerDay(input.logs);
  const y1 = new Date(input.today + 'T12:00:00Z');
  y1.setUTCFullYear(y1.getUTCFullYear() - 1);
  const m12 = maintenanceTotals(input.vehicleId, input.services, input.items, y1.toISOString().slice(0, 10));
  const mSince = input.logs.length ? maintenanceTotals(input.vehicleId, input.services, input.items, input.logs[0].date).total : 0;
  const best = iv.length ? iv.reduce((a, b) => (b.kml > a.kml ? b : a)) : null;
  const worst = iv.length ? iv.reduce((a, b) => (b.kml < a.kml ? b : a)) : null;

  const gastoSub = [monthLogs.length ? pl(monthLogs.length, 'abastecimento', 'abastecimentos') : '', maintThisMonth ? pl(maintThisMonth, 'manutenção', 'manutenções') : '']
    .filter(Boolean)
    .join(' + ');
  const v: Record<IndicatorId, Omit<IndValue, 'id' | 'name'>> = {
    gasto_mes: { value: brl(fuelMonth + maintMonth.total), sub: gastoSub || 'nada registrado em ' + mes },
    km_mes: { value: kmTxt(kmm.km), sub: kmm.lastDate ? 'até ' + dm(kmm.lastDate) : 'nada registrado em ' + mes },
    preco_gasolina: {
      value: Number.isFinite(pMes) ? brl(pMes) + '/l' : Number.isFinite(pGeral) ? brl(pGeral) + '/l' : '–',
      sub: Number.isFinite(pMes) ? 'em ' + mes + ' · ' + brl(pGeral) + ' no geral' : Number.isFinite(pGeral) ? 'no geral' : 'sem abastecimentos de gasolina',
    },
    ult3: { value: Number.isFinite(l3.kml) ? nf(l3.kml, 2) + ' km/l' : '–', sub: l3.n ? pl(l3.n, 'tanque', 'tanques') + ' · ' + kmTxt(l3.km) : 'precisa de 2 tanques cheios' },
    km_mes_media: { value: Number.isFinite(kd) ? kmTxt(kd * 30) : '–', sub: Number.isFinite(kd) ? nf(kd, 0) + ' km por dia' : 'precisa de 2 registros' },
    custo_km: { value: Number.isFinite(all.rpk) ? brl(all.rpk) + '/km' : '–', sub: 'só combustível' },
    custo_total_km: {
      value: all.km ? brl((all.cost + mSince) / all.km) + '/km' : '–',
      sub: input.logs.length ? 'com manutenção, desde ' + dm(input.logs[0].date) : 'combustível + manutenção',
    },
    manut_12m: { value: brl(m12.total), sub: pl(m12.visits, 'ida à oficina', 'idas à oficina') + (m12.total ? ' · mão de obra ' + brl(m12.labor) : '') },
    extremos: {
      value: best && worst ? nf(best.kml, 2) + ' / ' + nf(worst.kml, 2) : '–',
      sub: best && worst ? 'km/l · melhor ' + dm(best.date) + ', pior ' + dm(worst.date) : 'precisa de 2 tanques cheios',
    },
  };
  return Object.fromEntries(CATALOG.map((c) => [c.id, { id: c.id, name: c.name, ...v[c.id] }])) as Record<IndicatorId, IndValue>;
}

/* ---------- séries no tempo ---------- */
export type Period = '6m' | 'tudo';

function addMonthsKey(key: string, n: number): string {
  const y = +key.slice(0, 4), m = +key.slice(5, 7) - 1 + n;
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 7);
}

export function periodStart(input: IndInput, period: Period): string {
  if (period === '6m') return addMonthsKey(monthKey(input.today), -5) + '-01';
  const dates = [...input.logs.map((f) => f.date), ...input.services.filter((s) => !s.deleted_at && s.vehicle_id === input.vehicleId).map((s) => s.date)];
  return dates.length ? dates.reduce((a, b) => (b < a ? b : a)) : input.today;
}

export interface MonthSpend {
  key: string;
  fuel: number;
  maint: number;
  partial: boolean;
}

/** Gasto por mês (combustível e manutenção), meses contínuos do início do período até o mês atual. */
export function monthlySpend(input: IndInput, period: Period): MonthSpend[] {
  const start = monthKey(periodStart(input, period));
  const end = monthKey(input.today);
  const out: MonthSpend[] = [];
  for (let k = start; k <= end; k = addMonthsKey(k, 1)) {
    const fuel = input.logs.filter((f) => monthKey(f.date) === k).reduce((s, f) => s + f.total_brl, 0);
    const ids = new Set(input.services.filter((s) => !s.deleted_at && s.vehicle_id === input.vehicleId && monthKey(s.date) === k).map((s) => s.id));
    const maint = input.items.filter((i) => !i.deleted_at && ids.has(i.service_id)).reduce((s, i) => s + i.parts_brl + i.labor_brl, 0);
    out.push({ key: k, fuel: Math.round(fuel * 100) / 100, maint: Math.round(maint * 100) / 100, partial: k === end });
    if (out.length > 36) break;
  }
  return out;
}

export function pricePoints(input: IndInput, period: Period) {
  const start = periodStart(input, period);
  return [...input.logs]
    .filter((f) => f.date >= start)
    .sort((a, b) => a.date.localeCompare(b.date) || a.odometer_km - b.odometer_km)
    .map((f) => ({ date: f.date, price: f.price_per_l || f.total_brl / f.liters, fuel: f.fuel }));
}

export function tankSeries(input: IndInput, period: Period): { list: Interval[]; avg: number } {
  const start = periodStart(input, period);
  const iv = intervals(input.logs);
  return { list: iv.filter((x) => x.date >= start), avg: aggregate(iv).kml };
}
