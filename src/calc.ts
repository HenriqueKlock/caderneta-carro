import type { FuelLog, FuelType } from './db';

export interface Interval {
  id: string;
  /** Abastecimento que encheu o tanque no início deste trecho (de onde veio o combustível). */
  start_id: string;
  date: string;
  km: number;
  liters: number;
  cost: number;
  kml: number;
  rpk: number;
  fuel: FuelType | 'misto';
}

export interface Aggregate {
  km: number;
  liters: number;
  cost: number;
  kml: number;
  rpk: number;
  n: number;
}

/** Ordena por odômetro (desempate pela data). */
export function sortLogs(fs: FuelLog[]): FuelLog[] {
  return [...fs].sort((a, b) => a.odometer_km - b.odometer_km || a.date.localeCompare(b.date));
}

/**
 * Consumo tanque cheio a tanque cheio: km entre dois enchimentos ÷ litros colocados
 * desde o enchimento anterior (somando abastecimentos parciais no meio).
 */
export function intervals(sorted: FuelLog[]): Interval[] {
  const out: Interval[] = [];
  let anchor: FuelLog | null = null;
  let L = 0;
  let C = 0;
  let fuels = new Set<FuelType>();
  for (const f of sorted) {
    if (!anchor) {
      if (f.full_tank) anchor = f;
      continue;
    }
    L += f.liters;
    C += f.total_brl;
    fuels.add(f.fuel);
    if (f.full_tank) {
      const d = f.odometer_km - anchor.odometer_km;
      if (d > 0 && L > 0) {
        out.push({
          id: f.id,
          start_id: anchor.id,
          date: f.date,
          km: d,
          liters: L,
          cost: C,
          kml: d / L,
          rpk: C / d,
          fuel: fuels.size > 1 ? 'misto' : [...fuels][0],
        });
      }
      anchor = f;
      L = 0;
      C = 0;
      fuels = new Set();
    }
  }
  return out;
}

export function aggregate(iv: Interval[]): Aggregate {
  const km = iv.reduce((s, x) => s + x.km, 0);
  const liters = iv.reduce((s, x) => s + x.liters, 0);
  const cost = iv.reduce((s, x) => s + x.cost, 0);
  return { km, liters, cost, kml: liters ? km / liters : NaN, rpk: km ? cost / km : NaN, n: iv.length };
}

export function daysBetween(a: string, b: string): number {
  return (Date.parse(b + 'T12:00:00') - Date.parse(a + 'T12:00:00')) / 864e5;
}

/** km rodados por dia entre o primeiro e o último registro. */
export function kmPerDay(sorted: FuelLog[]): number {
  if (sorted.length < 2) return NaN;
  const a = sorted[0];
  const b = sorted[sorted.length - 1];
  const d = daysBetween(a.date, b.date);
  return d > 0 ? (b.odometer_km - a.odometer_km) / d : NaN;
}

/** Converte "6,99", "1.234,56", "6.99" em número. */
export function parseNum(v: unknown): number {
  if (v == null) return NaN;
  let s = String(v).trim().replace(/[^\d.,-]/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return parseFloat(s);
}
export function parseIntLoose(v: unknown): number {
  const s = String(v ?? '').replace(/\D/g, '');
  return s ? parseInt(s, 10) : NaN;
}
