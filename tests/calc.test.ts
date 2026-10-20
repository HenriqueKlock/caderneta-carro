import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, intervals, kmPerDay, parseNum, sortLogs } from '../src/calc.ts';

const mk = (date: string, total: number, liters: number, odo: number, full = true) => ({
  id: date, vehicle_id: 'v', date, odometer_km: odo, liters, total_brl: total, price_per_l: total / liters,
  fuel: 'gasolina' as const, full_tank: full, range_left_km: null, station: null, note: null,
  updated_at: '', deleted_at: null, _dirty: 0 as const,
});

// Dados fictícios: 3 tanques de 400 km com 40 l cada, a R$ 280 por tanque
const sample = [
  mk('2026-01-01', 280, 40, 10000), mk('2026-01-11', 280, 40, 10400),
  mk('2026-01-21', 280, 40, 10800), mk('2026-01-31', 280, 40, 11200),
];

test('consumo médio tanque cheio a tanque cheio', () => {
  const a = aggregate(intervals(sortLogs(sample)));
  assert.equal(a.n, 3);
  assert.equal(a.km, 1200);
  assert.equal(a.kml, 10);
  assert.equal(a.rpk, 0.7);
});

test('abastecimento parcial soma no tanque seguinte', () => {
  const fs = [mk('2026-01-01', 100, 20, 1000), mk('2026-01-05', 50, 10, 1100, false), mk('2026-01-10', 100, 20, 1300)];
  const iv = intervals(fs);
  assert.equal(iv.length, 1);
  assert.equal(iv[0].km, 300);
  assert.equal(iv[0].liters, 30);
});

test('ritmo de rodagem', () => {
  assert.equal(kmPerDay(sortLogs(sample)), 40);
});

test('números no formato brasileiro', () => {
  assert.equal(parseNum('1.234,56'), 1234.56);
  assert.equal(parseNum('6,99'), 6.99);
  assert.equal(parseNum('6.99'), 6.99);
  assert.ok(Number.isNaN(parseNum('')));
});
