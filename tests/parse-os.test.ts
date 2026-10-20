import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, extractOS, normalizeDraft, validateInput, InputError } from '../supabase/functions/parse-os/extract.ts';

const plan = [
  { key: 'oleo_motor', description: 'Óleo do motor' },
  { key: 'fluido_freio', description: 'Fluido de freio' },
];
const input = { file_base64: 'JVBERi0x', media_type: 'application/pdf', plan_items: plan, vehicle: { make: 'Marca', model: 'Modelo', year: 2020 } };

test('valida entrada', () => {
  assert.throws(() => validateInput({}), InputError);
  assert.throws(() => validateInput({ file_base64: 'x', media_type: 'text/plain' }), /PDF ou uma foto/);
  assert.equal(validateInput(input).plan_items.length, 2);
});

test('monta a chamada com PDF como document e ferramenta obrigatória', () => {
  const r: any = buildRequest(input);
  assert.equal(r.messages[0].content[0].type, 'document');
  assert.equal(r.tool_choice.name, 'registrar_os');
  assert.deepEqual(r.tools[0].input_schema.properties.items.items.properties.plan_item_key.enum, ['oleo_motor', 'fluido_freio', null]);
  const img: any = buildRequest({ ...input, media_type: 'image/jpeg' });
  assert.equal(img.messages[0].content[0].type, 'image');
});

test('normaliza o rascunho e confere totais', () => {
  const d = normalizeDraft(
    {
      date: '2026-01-15', odometer_km: 50000.4, shop: 'Oficina Exemplo', os_number: 'OS1', type: 'revisao',
      items: [
        { description: 'Óleo 5W30', quantity: '4 x R$ 50,00', plan_item_key: 'oleo_motor', parts_brl: 200, labor_brl: 0 },
        { description: 'Fluido DOT 4', plan_item_key: 'fluido_freio', parts_brl: 110, labor_brl: 150 },
        { description: 'Algo', plan_item_key: 'chave_inventada', parts_brl: -5, labor_brl: 0 },
      ],
      document_totals: { total_brl: 500 },
      warnings: ['Mão de obra repetida'],
    },
    plan.map((p) => p.key),
  );
  assert.equal(d.odometer_km, 50000);
  assert.equal(d.items[2].plan_item_key, null);
  assert.equal(d.items[2].parts_brl, 0);
  assert.equal(d.totals.total_brl, 460);
  assert.match(d.warnings[0], /não bate/);
  assert.ok(d.warnings.includes('Mão de obra repetida'));
});

test('extrai via API (fetch simulado) e traduz erros', async () => {
  const ok = (async () => ({
    ok: true, status: 200,
    json: async () => ({ model: 'claude-sonnet-5-5', usage: { input_tokens: 3000, output_tokens: 400 }, content: [{ type: 'tool_use', name: 'registrar_os', input: { type: 'revisao', items: [], warnings: [] } }] }),
  })) as unknown as typeof fetch;
  const r = await extractOS(validateInput(input), 'k', ok);
  assert.equal(r.usage.input_tokens, 3000);
  assert.ok(r.draft.warnings.some((w) => /itens/.test(w)));
  const unauthorized = (async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }) })) as unknown as typeof fetch;
  await assert.rejects(extractOS(validateInput(input), 'k', unauthorized), /inválida/);
});
