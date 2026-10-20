/**
 * Planos de manutenção do fabricante, embutidos no app (funcionam offline).
 * Itens marcados como `preliminary` ainda não foram conferidos no manual do proprietário.
 */
export type PlanAction = 'trocar' | 'inspecionar';

export interface PlanItem {
  key: string;
  description: string;
  action: PlanAction;
  interval_km: number | null;
  interval_months: number | null;
  /** Intervalo em uso severo, só informativo. */
  severe_km?: number | null;
  note?: string;
  preliminary: boolean;
}

export interface Plan {
  key: string;
  name: string;
  summary: string;
  sources: { label: string; url: string }[];
  items: PlanItem[];
}

export const PLANS: Plan[] = [
  {
    key: 'hyundai-creta-2.0-at-2017-2021',
    name: 'Hyundai Creta 2.0 AT (2017–2021)',
    summary:
      'Revisões a cada 10.000 km ou 12 meses. Detalhe por item vem do Creta 1.6 AT; conferir no manual do 2.0 os itens marcados.',
    sources: [
      { label: 'Motor Show: revisões do Creta até 100 mil km', url: 'https://motorshow.com.br/veja-quanto-custa-manter-um-hyundai-creta-1-6-ate-os-100-000-km/' },
      { label: 'O Mecânico: Raio X do Creta 1.6 AT', url: 'https://omecanico.com.br/raio-x-hyundai-creta-1-6-at/' },
    ],
    items: [
      { key: 'oleo_motor', description: 'Óleo do motor', action: 'trocar', interval_km: 10000, interval_months: 12, severe_km: 5000, preliminary: false },
      { key: 'filtro_oleo', description: 'Filtro de óleo', action: 'trocar', interval_km: 10000, interval_months: 12, severe_km: 5000, preliminary: false },
      { key: 'filtro_cabine', description: 'Filtro de cabine (ar-condicionado)', action: 'trocar', interval_km: 20000, interval_months: 24, preliminary: true },
      { key: 'filtro_ar', description: 'Filtro de ar do motor', action: 'trocar', interval_km: 40000, interval_months: 48, note: 'Antes, se estiver sujo', preliminary: true },
      { key: 'filtro_combustivel', description: 'Filtro de combustível', action: 'trocar', interval_km: null, interval_months: null, note: 'Intervalo não consta nas fontes; conferir no manual', preliminary: true },
      { key: 'correia_acessorios', description: 'Correia de acessórios', action: 'inspecionar', interval_km: 30000, interval_months: null, note: 'Sem troca programada', preliminary: true },
      { key: 'velas', description: 'Velas de ignição', action: 'trocar', interval_km: 160000, interval_months: null, note: 'Intervalo do 1.6; mecânico recomenda inspecionar a cada 30.000 km', preliminary: true },
      { key: 'arrefecimento', description: 'Líquido de arrefecimento', action: 'trocar', interval_km: 100000, interval_months: null, preliminary: true },
      { key: 'fluido_freio', description: 'Fluido de freio', action: 'trocar', interval_km: null, interval_months: 24, note: 'Recomendação de mecânico; o manual do 1.6 não fixa intervalo', preliminary: true },
      { key: 'folga_valvulas', description: 'Folga de válvulas', action: 'inspecionar', interval_km: 90000, interval_months: 72, preliminary: true },
      { key: 'fluido_cambio', description: 'Fluido do câmbio automático', action: 'trocar', interval_km: null, interval_months: null, severe_km: 100000, note: 'Sem troca em uso normal; 100.000 km em uso severo', preliminary: true },
    ],
  },
];

export const planByKey = (key: string | null | undefined) => PLANS.find((p) => p.key === key);
