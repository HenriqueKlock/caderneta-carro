import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeIndicators, kmInMonth, monthlySpend, pricePoints, tankSeries, isIndicatorId } from '../src/indicators.ts';

// Dados fictícios
const mk = (id: string, date: string, total: number, liters: number, odo: number, fuel: 'gasolina' | 'etanol' = 'gasolina') => ({
  id, vehicle_id: 'v', date, odometer_km: odo, liters, total_brl: total, price_per_l: total / liters, fuel, full_tank: true,
  range_left_km: null, station: null, note: null, updated_at: '', deleted_at: null, _dirty: 0 as const,
});
const logs = [
  mk('a', '2026-01-10', 280, 40, 10000),
  mk('b', '2026-01-25', 280, 40, 10400),
  mk('c', '2026-02-05', 300, 40, 10800),
  mk('d', '2026-02-20', 200, 40, 11200, 'etanol'),
];
const services = [{ id: 's1', vehicle_id: 'v', date: '2026-02-10', odometer_km: 11000, deleted_at: null }];
const items = [{ service_id: 's1', plan_item_key: 'oleo_motor', parts_brl: 300, labor_brl: 100, next_due_km: null, next_due_date: null, deleted_at: null }];
const input = { vehicleId: 'v', logs, services, items, today: '2026-02-26' };

test('km rodados no mês usa o último odômetro do mês anterior', () => {
  assert.deepEqual(kmInMonth(input, '2026-02'), { km: 800, lastDate: '2026-02-20' });
  assert.equal(kmInMonth(input, '2026-01').km, 400); // sem mês anterior: primeiro ao último do mês
  assert.equal(kmInMonth(input, '2026-03').km, 0);
});

test('indicadores do mês', () => {
  const ind = computeIndicators(input);
  assert.equal(ind.gasto_mes.value, 'R$ 900,00'); // 300 + 200 combustível + 400 manutenção
  assert.equal(ind.gasto_mes.sub, '2 abastecimentos + 1 manutenção');
  assert.equal(ind.km_mes.value, '800 km');
  assert.equal(ind.preco_gasolina.value, 'R$ 7,50/l'); // só gasolina em fevereiro
  assert.match(ind.preco_gasolina.sub, /R\$ 7,17 no geral/); // 860 / 120
  assert.equal(ind.ult3.value, '10,00 km/l');
  assert.equal(ind.custo_total_km.value, 'R$ 0,98/km'); // (780 + 400) / 1200
  assert.equal(ind.manut_12m.value, 'R$ 400,00');
  assert.ok(isIndicatorId('km_mes') && !isIndicatorId('xx'));
});

test('séries no tempo', () => {
  const m = monthlySpend(input, 'tudo');
  assert.deepEqual(m.map((x) => [x.key, x.fuel, x.maint, x.partial]), [['2026-01', 560, 0, false], ['2026-02', 500, 400, true]]);
  assert.equal(monthlySpend(input, '6m').length, 6);
  assert.equal(pricePoints(input, 'tudo').length, 4);
  const t = tankSeries(input, 'tudo');
  assert.equal(t.list.length, 3);
  assert.equal(t.avg, 10);
});
