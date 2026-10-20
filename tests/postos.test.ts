import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distToPathKm, haversineKm, priceOf, recommend, reliability, simplify, sortRows, stationsFor, type CarModel, type Station } from '../src/postos.ts';

// Postos e preços fictícios
const base = { lat: -27.6, lon: -48.5 };
const at = (dLatKm: number, dLonKm: number) => ({ la: base.lat + dLatKm / 110.57, lo: base.lon + dLonKm / (111.32 * Math.cos((base.lat * Math.PI) / 180)) });
const st = (c: string, pos: { la: number; lo: number }, pr: Station['pr'], f?: Station['f']): Station => ({ c, n: 'Posto ' + c, b: 'Bandeira branca', e: 'Rua A', br: 'Centro', m: 'Cidade', pg: 'n', ...pos, pr, f });
const today = '2026-10-20';
const car: CarModel = { kmlG: 10, kmlE: 7, measured: true, fuels: ['gasolina', 'etanol'], kmTank: 450 };

test('distâncias', () => {
  assert.ok(Math.abs(haversineKm(base, { lat: base.lat + 1 / 110.57, lon: base.lon }) - 1) < 0.01);
  const path = [{ lat: base.lat, lon: base.lon }, { lat: base.lat, lon: base.lon + 0.1 }];
  const p = { lat: base.lat + 0.5 / 110.57, lon: base.lon + 0.05 };
  assert.ok(Math.abs(distToPathKm(p, path) - 0.5) < 0.01);
});

test('simplifica rota reta para as pontas', () => {
  const line = Array.from({ length: 50 }, (_, i) => ({ lat: base.lat, lon: base.lon + i * 0.001 }));
  assert.equal(simplify(line).length, 2);
});

test('confiabilidade: sem ocorrências, infração antiga e interdição recente', () => {
  assert.equal(reliability(st('1', at(0, 0), {}, { n: 3, ult: '2026-01-01', ev: [] }), today).score, 5);
  assert.equal(reliability(st('2', at(0, 0), {}), today).score, 4.2);
  const old = reliability(st('3', at(0, 0), {}, { n: 2, ult: '2022-05-01', ev: [['2022-05-01', 'I', 'x']] }), today);
  assert.ok(old.score > 4.5 && old.level === 'ok');
  const bad = reliability(st('4', at(0, 0), {}, { n: 1, ult: '2026-06-01', ev: [['2026-06-01', 'D', 'bomba lacrada']] }), today);
  assert.equal(bad.recentSerious, true);
  assert.equal(bad.level, 'evitar');
  const withGoogle = reliability(st('5', at(0, 0), {}, { n: 1, ult: '2026-01-01', ev: [] }), today, { rating: 3.0, count: 400 });
  assert.ok(withGoogle.score < 5 && withGoogle.google! < 3.2);
});

test('preço: o que você pagou vence a ANP quando é mais novo', () => {
  const s = st('9', at(0, 0), { gc: [6.5, '2026-10-08'] });
  assert.deepEqual(priceOf(s, 'gasolina', []), { price: 6.5, date: '2026-10-08', src: 'anp' });
  assert.equal(priceOf(s, 'gasolina', [{ station_id: '9', fuel: 'gasolina', price: 6.39, date: '2026-10-15' }])!.src, 'voce');
  assert.equal(priceOf(s, 'gasolina', [{ station_id: '9', fuel: 'gasolina', price: 6.39, date: '2026-09-01' }])!.src, 'anp');
});

test('recomendação: etanol perto vence; posto mais barato com interdição recente fica fora; distância conta', () => {
  const stations = [
    st('A', at(1, 0), { gc: [6.69, '2026-10-08'], et: [4.59, '2026-10-08'] }), // 1 km
    st('B', at(4, 0), { gc: [6.59, '2026-10-08'], et: [4.55, '2026-10-08'] }), // 4 km, um pouco mais barato
    st('C', at(2, 0), { gc: [6.29, '2026-10-08'], et: [4.19, '2026-10-08'] }, { n: 1, ult: '2026-08-01', ev: [['2026-08-01', 'I', 'volume a menor']] }),
    st('D', at(30, 0), { gc: [5.0, '2026-10-08'] }), // fora do raio
    st('E', at(0.5, 0), { gc: [6.0, '2026-07-01'] }), // preço velho
  ];
  const rows = stationsFor(stations, { kind: 'ponto', at: base, radiusKm: 6 }, car, [], today);
  assert.deepEqual(rows.map((r) => r.s.c).sort(), ['A', 'B', 'C', 'E']);
  const rec = recommend(rows);
  // etanol: 4,59/7 = 0,656/km vs gasolina 6,69/10 = 0,669/km
  assert.equal(rec.best!.s.c, 'A');
  assert.equal(rec.best!.fuel, 'etanol');
  assert.equal(rec.bestOther!.fuel, 'gasolina');
  assert.equal(rec.cheaperUnsafe!.s.c, 'C');
  const order = sortRows(rows).map((r) => r.s.c);
  assert.deepEqual(order.slice(0, 2), ['A', 'B']);
  assert.ok(order.indexOf('C') > 1 && order.indexOf('E') > 1);
});

test('rota: só postos perto do caminho, desvio pesa no custo', () => {
  const path = [{ lat: base.lat, lon: base.lon }, { lat: base.lat + 10 / 110.57, lon: base.lon }];
  const stations = [st('perto', at(5, 0.2), { gc: [6.6, '2026-10-08'] }), st('longe', at(5, 3), { gc: [6.0, '2026-10-08'] })];
  const rows = stationsFor(stations, { kind: 'rota', path, detourKm: 1 }, { ...car, fuels: ['gasolina'] }, [], today);
  assert.deepEqual(rows.map((r) => r.s.c), ['perto']);
  assert.ok(rows[0].extraKm < 1);
});

test('infração só de documentos reduz a nota, mas não tira da recomendação', () => {
  const r = reliability(st('6', at(0, 0), {}, { n: 1, ult: '2026-08-01', ev: [['2026-08-01', 'I', 'Não possuir documentos necessários para outorga de autorização']] }), today);
  assert.equal(r.recentSerious, false);
  assert.equal(r.score, 3.8);
});
