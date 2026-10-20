import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, dueByKm, itemStates, lastDoneByKey, maintenanceTotals, sortStates } from '../src/maintenance.ts';
import { PLANS } from '../src/plans.ts';

// Dados fictícios
const plan = PLANS[0];
const services = [
  { id: 's1', vehicle_id: 'v', date: '2025-01-10', odometer_km: 50000, deleted_at: null },
  { id: 's0', vehicle_id: 'v', date: '2024-01-05', odometer_km: 40000, deleted_at: null },
  { id: 'sx', vehicle_id: 'outro', date: '2025-06-01', odometer_km: 1000, deleted_at: null },
];
const it = (service_id: string, key: string | null, parts = 0, labor = 0, extra: object = {}) => ({
  service_id, plan_item_key: key, parts_brl: parts, labor_brl: labor, next_due_km: null, next_due_date: null, deleted_at: null, ...extra,
});
const items = [
  it('s0', 'oleo_motor', 200), it('s1', 'oleo_motor', 220), it('s1', 'filtro_oleo', 35),
  it('s1', 'fluido_freio', 110, 150), it('s1', 'filtro_combustivel', 35), it('s1', null, 0, 150),
  it('sx', 'folga_valvulas', 0, 300),
];

test('soma de meses respeita fim de mês', () => {
  assert.equal(addMonths('2025-01-31', 1), '2025-02-28');
  assert.equal(addMonths('2025-09-11', 12), '2026-09-11');
});

test('última vez por item ignora outros carros e pega a mais recente', () => {
  const last = lastDoneByKey('v', services, items);
  assert.equal(last.get('oleo_motor')?.km, 50000);
  assert.equal(last.has('folga_valvulas'), false);
});

test('status das próximas manutenções', () => {
  const last = lastDoneByKey('v', services, items);
  const st = Object.fromEntries(itemStates(plan, last, 59200, '2025-11-01', 40).map((s) => [s.item.key, s]));
  assert.equal(st.oleo_motor.status, 'proxima');
  assert.equal(st.oleo_motor.due_km, 60000);
  assert.equal(st.oleo_motor.remaining_km, 800);
  assert.equal(st.oleo_motor.est_date, '2025-11-21');
  assert.equal(st.fluido_freio.status, 'em_dia');
  assert.equal(st.fluido_freio.due_date, '2027-01-10');
  assert.equal(st.folga_valvulas.status, 'sem_historico');
  assert.equal(st.filtro_combustivel.status, 'sem_intervalo');
  const order = sortStates(Object.values(st)).map((s) => s.status);
  assert.equal(order[0], 'proxima');
});

test('vencida por data mesmo sem atingir o km', () => {
  const last = lastDoneByKey('v', services, items);
  const st = itemStates(plan, last, 52000, '2026-02-01', 5).find((s) => s.item.key === 'oleo_motor')!;
  assert.equal(st.status, 'vencida');
});

test('o que vence até um km alvo', () => {
  const last = lastDoneByKey('v', services, items);
  const states = itemStates(plan, last, 59200, '2025-11-01', 40);
  const r = dueByKm(states, 60000, 59200, '2025-11-01', 40);
  assert.deepEqual(r.due.map((s) => s.item.key).sort(), ['filtro_oleo', 'oleo_motor']);
  assert.ok(r.check.some((s) => s.item.key === 'folga_valvulas'));
});

test('totais separam peças e mão de obra por carro', () => {
  const t = maintenanceTotals('v', services, items);
  assert.equal(t.parts, 600);
  assert.equal(t.labor, 300);
  assert.equal(t.visits, 2);
  assert.equal(maintenanceTotals('v', services, items, '2025-01-01').total, 700);
});

test('progresso pelo km ou pelo tempo', async () => {
  const { progressOf } = await import('../src/maintenance.ts');
  const last = lastDoneByKey('v', services, items);
  const st = itemStates(plan, last, 52000, '2025-07-10', 40).find((s) => s.item.key === 'oleo_motor')!;
  // km: 2.000 de 10.000 = 20%; tempo: 181 de 365 dias ≈ 50% → vale o maior
  assert.equal(Math.round(progressOf(st, 52000, '2025-07-10')! * 100), 50);
});
