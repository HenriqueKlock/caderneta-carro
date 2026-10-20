import type { Plan, PlanItem } from './plans';

/** Formas mínimas, para o cálculo não depender do Dexie. */
export interface SvcLike {
  id: string;
  vehicle_id: string;
  date: string;
  odometer_km: number | null;
  deleted_at: string | null;
}
export interface SvcItemLike {
  service_id: string;
  plan_item_key: string | null;
  parts_brl: number;
  labor_brl: number;
  next_due_km: number | null;
  next_due_date: string | null;
  deleted_at: string | null;
}

export type DueStatus = 'vencida' | 'proxima' | 'em_dia' | 'sem_historico' | 'sem_intervalo';

export interface ItemState {
  item: PlanItem;
  status: DueStatus;
  last_date: string | null;
  last_km: number | null;
  due_km: number | null;
  due_date: string | null;
  remaining_km: number | null;
  remaining_days: number | null;
  /** Data estimada em que o km será atingido, no ritmo atual. */
  est_date: string | null;
}

export const SOON_KM = 1000;
export const SOON_DAYS = 30;

const DAY = 864e5;
const toDate = (iso: string) => new Date(iso + 'T12:00:00Z');
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export function addMonths(iso: string, months: number): string {
  const d = toDate(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return isoDate(d);
}
export const daysDiff = (from: string, to: string) => Math.round((toDate(to).getTime() - toDate(from).getTime()) / DAY);

/** Última vez que cada item do plano foi feito neste carro. */
export function lastDoneByKey(vehicleId: string, services: SvcLike[], items: SvcItemLike[]) {
  const svc = new Map(services.filter((s) => !s.deleted_at && s.vehicle_id === vehicleId).map((s) => [s.id, s]));
  const out = new Map<string, { date: string; km: number | null; next_due_km: number | null; next_due_date: string | null }>();
  for (const it of items) {
    if (it.deleted_at || !it.plan_item_key) continue;
    const s = svc.get(it.service_id);
    if (!s) continue;
    const cur = out.get(it.plan_item_key);
    const newer = !cur || s.date > cur.date || (s.date === cur.date && (s.odometer_km ?? 0) > (cur.km ?? 0));
    if (newer) out.set(it.plan_item_key, { date: s.date, km: s.odometer_km, next_due_km: it.next_due_km, next_due_date: it.next_due_date });
  }
  return out;
}

export function itemStates(
  plan: Plan,
  last: ReturnType<typeof lastDoneByKey>,
  currentKm: number,
  today: string,
  kmPerDay: number,
): ItemState[] {
  return plan.items.map((item) => {
    const l = last.get(item.key);
    const base: ItemState = { item, status: 'sem_historico', last_date: l?.date ?? null, last_km: l?.km ?? null, due_km: null, due_date: null, remaining_km: null, remaining_days: null, est_date: null };
    if (!item.interval_km && !item.interval_months && !l?.next_due_km && !l?.next_due_date) {
      return { ...base, status: l ? 'sem_intervalo' : 'sem_historico' };
    }
    if (!l) return base;
    const due_km = l.next_due_km ?? (item.interval_km && l.km != null ? l.km + item.interval_km : null);
    const due_date = l.next_due_date ?? (item.interval_months ? addMonths(l.date, item.interval_months) : null);
    const remaining_km = due_km != null ? due_km - currentKm : null;
    const remaining_days = due_date ? daysDiff(today, due_date) : null;
    let est_date: string | null = null;
    if (remaining_km != null && Number.isFinite(kmPerDay) && kmPerDay > 0) {
      est_date = isoDate(new Date(toDate(today).getTime() + Math.max(0, remaining_km / kmPerDay) * DAY));
    }
    let status: DueStatus = 'em_dia';
    if ((remaining_km != null && remaining_km <= 0) || (remaining_days != null && remaining_days <= 0)) status = 'vencida';
    else if ((remaining_km != null && remaining_km <= SOON_KM) || (remaining_days != null && remaining_days <= SOON_DAYS)) status = 'proxima';
    return { ...base, status, due_km, due_date, remaining_km, remaining_days, est_date };
  });
}

const ORDER: Record<DueStatus, number> = { vencida: 0, proxima: 1, sem_historico: 2, em_dia: 3, sem_intervalo: 4 };
export function sortStates(states: ItemState[]): ItemState[] {
  const urgency = (s: ItemState) => {
    const byKm = s.remaining_km ?? Infinity;
    const byDays = s.remaining_days != null ? s.remaining_days * 40 : Infinity; // ~40 km/dia para comparar
    return Math.min(byKm, byDays);
  };
  return [...states].sort((a, b) => ORDER[a.status] - ORDER[b.status] || urgency(a) - urgency(b));
}

/**
 * O que vence até um km alvo: itens cujo km previsto ≤ alvo, ou cuja data prevista
 * chega antes da data estimada para o alvo. Itens sem histórico entram como "verificar".
 */
export function dueByKm(states: ItemState[], targetKm: number, currentKm: number, today: string, kmPerDay: number) {
  const targetDate =
    Number.isFinite(kmPerDay) && kmPerDay > 0 ? isoDate(new Date(toDate(today).getTime() + Math.max(0, (targetKm - currentKm) / kmPerDay) * DAY)) : null;
  const due = states.filter(
    (s) => (s.due_km != null && s.due_km <= targetKm) || (s.due_date != null && targetDate != null && s.due_date <= targetDate),
  );
  const check = states.filter((s) => s.status === 'sem_historico' && (s.item.interval_km || s.item.interval_months));
  return { targetDate, due, check };
}

/** Totais de manutenção de um carro, opcionalmente a partir de uma data. */
export function maintenanceTotals(vehicleId: string, services: SvcLike[], items: SvcItemLike[], since?: string) {
  const ok = new Set(services.filter((s) => !s.deleted_at && s.vehicle_id === vehicleId && (!since || s.date >= since)).map((s) => s.id));
  let parts = 0;
  let labor = 0;
  for (const it of items) {
    if (it.deleted_at || !ok.has(it.service_id)) continue;
    parts += it.parts_brl;
    labor += it.labor_brl;
  }
  return { parts, labor, total: parts + labor, visits: ok.size };
}

/** Quanto do intervalo já foi usado (0 a 1), pelo km ou pelo tempo, o que estiver mais adiantado. */
export function progressOf(s: ItemState, currentKm: number, today: string): number | null {
  const parts: number[] = [];
  if (s.due_km != null && s.last_km != null && s.due_km > s.last_km) parts.push((currentKm - s.last_km) / (s.due_km - s.last_km));
  if (s.due_date && s.last_date) {
    const total = daysDiff(s.last_date, s.due_date);
    if (total > 0) parts.push(daysDiff(s.last_date, today) / total);
  }
  if (!parts.length) return null;
  return Math.min(1, Math.max(0, Math.max(...parts)));
}
