// Lógica pura da leitura de OS: monta a chamada à API do Claude e valida a resposta.
// Sem APIs do Deno, para poder ser testada no Node.

export interface PlanItemRef {
  key: string;
  description: string;
}

export interface VehicleRef {
  name?: string | null;
  make?: string | null;
  model?: string | null;
  year?: number | null;
}

export interface ParseInput {
  file_base64: string;
  media_type: string;
  plan_items: PlanItemRef[];
  vehicle?: VehicleRef;
}

export interface DraftItem {
  description: string;
  quantity: string | null;
  plan_item_key: string | null;
  parts_brl: number;
  labor_brl: number;
}

export interface Draft {
  date: string | null;
  odometer_km: number | null;
  shop: string | null;
  os_number: string | null;
  type: 'revisao' | 'corretiva' | 'pneus' | 'outros';
  items: DraftItem[];
  totals: { parts_brl: number; labor_brl: number; total_brl: number };
  document_totals: { parts_brl: number | null; labor_brl: number | null; total_brl: number | null };
  warnings: string[];
}

export const MAX_BASE64 = 14_000_000; // ~10 MB de arquivo
export const MEDIA_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

export class InputError extends Error {}

export function validateInput(body: unknown): ParseInput {
  const b = body as Partial<ParseInput>;
  if (!b || typeof b.file_base64 !== 'string' || !b.file_base64) throw new InputError('Arquivo ausente.');
  if (b.file_base64.length > MAX_BASE64) throw new InputError('Arquivo grande demais (máximo 10 MB).');
  if (!b.media_type || !MEDIA_TYPES.includes(b.media_type)) throw new InputError('Envie um PDF ou uma foto (JPG, PNG ou WebP).');
  const plan_items = Array.isArray(b.plan_items)
    ? b.plan_items.filter((p) => p && typeof p.key === 'string' && typeof p.description === 'string').slice(0, 60)
    : [];
  return { file_base64: b.file_base64, media_type: b.media_type, plan_items, vehicle: b.vehicle ?? undefined };
}

const SYSTEM = `Você lê ordens de serviço (OS) de oficinas mecânicas brasileiras e transforma em dados estruturados para um app de controle de manutenção do carro.

Regras:
- Responda chamando a ferramenta registrar_os, uma única vez.
- Cada peça vira um item, com o valor total da linha (quantidade × preço unitário) em parts_brl e labor_brl = 0.
- Cada serviço de mão de obra vira labor_brl. Quando o serviço corresponde claramente a uma peça (por exemplo, "substituição de líquido de freio" e a peça "DOT 4"), some a mão de obra no item dessa peça. Quando não corresponde a nenhuma peça, crie um item próprio começando com "Mão de obra:".
- plan_item_key: use a chave do plano que corresponde ao item, ou null se nenhuma corresponder. Não force correspondências.
- Valores em reais como número (1.234,56 vira 1234.56). Datas em AAAA-MM-DD; prefira a data de conclusão do serviço, senão a de emissão.
- odometer_km: a quilometragem do veículo na OS, como inteiro.
- type: "revisao" para revisão programada; "corretiva" para conserto; "pneus" para pneus, alinhamento ou balanceamento; senão "outros".
- document_totals: os totais impressos na OS (peças, mão de obra, total), ou null se não houver.
- warnings: liste, em português e em frases curtas, tudo o que o dono deve conferir: linhas de serviço repetidas, totais que não batem, peças trocadas ou removidas no histórico da OS, dados do veículo que não batem com o carro informado (ano, modelo), valores ilegíveis.
- Não inclua placa, CPF, telefone, e-mail ou nome do cliente em nenhum campo.`;

export function buildRequest(input: ParseInput, model = DEFAULT_MODEL) {
  const keys = input.plan_items.map((p) => p.key);
  const planText = input.plan_items.length
    ? input.plan_items.map((p) => `- ${p.key}: ${p.description}`).join('\n')
    : '(este carro ainda não tem plano; use null em plan_item_key)';
  const v = input.vehicle ?? {};
  const vehicleText = [v.make, v.model, v.year].filter(Boolean).join(' ') || v.name || 'não informado';
  const fileBlock =
    input.media_type === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.file_base64 } }
      : { type: 'image', source: { type: 'base64', media_type: input.media_type, data: input.file_base64 } };
  return {
    model,
    max_tokens: 2500,
    system: SYSTEM,
    tools: [
      {
        name: 'registrar_os',
        description: 'Registra os dados extraídos da ordem de serviço.',
        input_schema: {
          type: 'object',
          required: ['type', 'items', 'warnings'],
          properties: {
            date: { type: ['string', 'null'] },
            odometer_km: { type: ['integer', 'null'] },
            shop: { type: ['string', 'null'], description: 'Nome da oficina' },
            os_number: { type: ['string', 'null'] },
            type: { type: 'string', enum: ['revisao', 'corretiva', 'pneus', 'outros'] },
            items: {
              type: 'array',
              items: {
                type: 'object',
                required: ['description', 'parts_brl', 'labor_brl'],
                properties: {
                  description: { type: 'string' },
                  quantity: { type: ['string', 'null'], description: 'Ex.: "4 x R$ 50,00"' },
                  plan_item_key: keys.length ? { type: ['string', 'null'], enum: [...keys, null] } : { type: 'null' },
                  parts_brl: { type: 'number' },
                  labor_brl: { type: 'number' },
                },
              },
            },
            document_totals: {
              type: 'object',
              properties: {
                parts_brl: { type: ['number', 'null'] },
                labor_brl: { type: ['number', 'null'] },
                total_brl: { type: ['number', 'null'] },
              },
            },
            warnings: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'registrar_os' },
    messages: [
      {
        role: 'user',
        content: [
          fileBlock,
          { type: 'text', text: `Carro do dono: ${vehicleText}.\n\nItens do plano de manutenção deste carro:\n${planText}\n\nLeia a OS e registre.` },
        ],
      },
    ],
  };
}

const money = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);
const optMoney = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
const str = (s: unknown, max = 200) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, max) : null);

/** Valida a saída do modelo e acrescenta conferências que não dependem dele. */
export function normalizeDraft(raw: any, planKeys: string[]): Draft {
  const keys = new Set(planKeys);
  const items: DraftItem[] = (Array.isArray(raw?.items) ? raw.items : [])
    .map((it: any) => ({
      description: str(it?.description, 160) ?? 'Item sem descrição',
      quantity: str(it?.quantity, 60),
      plan_item_key: typeof it?.plan_item_key === 'string' && keys.has(it.plan_item_key) ? it.plan_item_key : null,
      parts_brl: Math.max(0, money(it?.parts_brl)),
      labor_brl: Math.max(0, money(it?.labor_brl)),
    }))
    .slice(0, 80);
  const totals = {
    parts_brl: money(items.reduce((s, i) => s + i.parts_brl, 0)),
    labor_brl: money(items.reduce((s, i) => s + i.labor_brl, 0)),
    total_brl: 0,
  };
  totals.total_brl = money(totals.parts_brl + totals.labor_brl);
  const doc = {
    parts_brl: optMoney(raw?.document_totals?.parts_brl),
    labor_brl: optMoney(raw?.document_totals?.labor_brl),
    total_brl: optMoney(raw?.document_totals?.total_brl),
  };
  const warnings: string[] = (Array.isArray(raw?.warnings) ? raw.warnings : []).map((w: unknown) => str(w, 300)).filter(Boolean) as string[];
  const fmt = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (doc.total_brl != null && Math.abs(doc.total_brl - totals.total_brl) > 0.01) {
    warnings.unshift(`A soma dos itens (R$ ${fmt(totals.total_brl)}) não bate com o total da OS (R$ ${fmt(doc.total_brl)}).`);
  }
  const date = typeof raw?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null;
  const km = typeof raw?.odometer_km === 'number' && raw.odometer_km > 0 ? Math.round(raw.odometer_km) : null;
  if (!date) warnings.push('Não encontrei a data na OS; confira.');
  if (!km) warnings.push('Não encontrei a quilometragem na OS; confira.');
  if (!items.length) warnings.push('Não encontrei itens na OS.');
  const type = ['revisao', 'corretiva', 'pneus', 'outros'].includes(raw?.type) ? raw.type : 'outros';
  return { date, odometer_km: km, shop: str(raw?.shop, 80), os_number: str(raw?.os_number, 40), type, items, totals, document_totals: doc, warnings };
}

/** Chama a API e devolve o rascunho. `fetchFn` é injetável para testes. */
export async function extractOS(input: ParseInput, apiKey: string, fetchFn: typeof fetch = fetch, model = DEFAULT_MODEL) {
  const res = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(buildRequest(input, model)),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new Error('Chave da API do Claude inválida.');
    if (res.status === 402 || /credit|billing/i.test(msg)) throw new Error('Sem créditos na conta da API do Claude.');
    if (res.status === 429 || res.status === 529) throw new Error('A API do Claude está ocupada. Tente de novo em instantes.');
    throw new Error('Falha na API do Claude: ' + msg);
  }
  const call = (body.content ?? []).find((c: any) => c.type === 'tool_use' && c.name === 'registrar_os');
  if (!call) throw new Error('A leitura não retornou dados. Tente uma foto mais nítida ou o PDF original.');
  return {
    draft: normalizeDraft(call.input, input.plan_items.map((p) => p.key)),
    usage: { input_tokens: body.usage?.input_tokens ?? null, output_tokens: body.usage?.output_tokens ?? null, model: body.model ?? model },
  };
}
