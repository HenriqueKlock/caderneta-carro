import { db, softDelete, stamp, uuid, type FuelLog, type PendingFile, type Service, type ServiceItem, type Vehicle } from './db';
import { kmPerDay } from './calc';
import { PLANS, planByKey } from './plans';
import { dueByKm, itemStates, lastDoneByKey, maintenanceTotals, progressOf, sortStates, type ItemState } from './maintenance';
import { ICON } from './icons';
import { attachmentUrl, currentSession, parseOS, type OsDraft } from './sync';

export interface MaintCtx {
  $: <T extends HTMLElement = HTMLElement>(id: string) => T;
  fmt: (n: number, d?: number) => string;
  brl: (n: number) => string;
  km: (n: number) => string;
  esc: (s: unknown) => string;
  pl: (n: number, one: string, many: string) => string;
  todayISO: () => string;
  toast: (m: string) => void;
  openSheet: (id: string) => void;
  closeSheets: () => void;
  parseNum: (v: unknown) => number;
  parseIntLoose: (v: unknown) => number;
}

export interface MaintData {
  vehicle: Vehicle | undefined;
  logs: FuelLog[]; // do carro atual, ordenados
  services: Service[];
  items: ServiceItem[];
  pending: PendingFile[];
}

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const monthYear = (iso: string) => MESES[+iso.slice(5, 7) - 1] + '/' + iso.slice(2, 4);
const dmy = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(2, 4);
const TYPE_LABEL: Record<Service['type'], string> = { revisao: 'Revisão', corretiva: 'Conserto', pneus: 'Pneus', outros: 'Outros' };
const STATUS_LABEL = { vencida: 'Vencida', proxima: 'Próxima', em_dia: 'Em dia', sem_historico: 'Sem histórico', sem_intervalo: 'Sem intervalo' } as const;

/** Km atual do carro: maior valor entre abastecimentos, manutenções e o km do cadastro. */
export function currentKmOf(v: Vehicle | undefined, logs: FuelLog[], services: Service[]): number {
  if (!v) return 0;
  const svcKm = services.filter((s) => s.vehicle_id === v.id && !s.deleted_at).map((s) => s.odometer_km ?? 0);
  return Math.max(v.initial_km ?? 0, ...logs.map((f) => f.odometer_km), ...svcKm, 0);
}

export function initMaintenance(c: MaintCtx) {
  const { $, brl, km, esc, pl, toast } = c;
  let data: MaintData = { vehicle: undefined, logs: [], services: [], items: [], pending: [] };
  let targetKm: number | null = null;

  /* ---------- markup ---------- */
  $('v-manut').innerHTML = `
    <div class="page-head"><h1>Manutenção</h1><span class="muted" id="m-car"></span></div>
    <div id="m-alert"></div>
    <div class="btn-row">
      <button type="button" class="btn primary" id="m-import">${ICON.doc}Importar OS</button>
      <button type="button" class="btn" id="m-new">Lançar à mão</button>
    </div>
    <input type="file" id="m-file" accept="application/pdf,image/*" hidden>
    <div id="m-pending" class="list-card" hidden></div>
    <div class="list-card" id="m-plan-card">
      <div id="m-next"></div>
      <button type="button" class="list-more" id="m-more" hidden></button>
    </div>
    <p class="foot-note" id="m-plan-note"></p>
    <div class="card" id="m-target-card">
      <div class="card-head"><span>Quando chegar em</span><span class="hint" id="m-target-when"></span></div>
      <div class="suffix" style="max-width:200px"><input class="inp sm" id="m-target" inputmode="numeric" aria-label="Quilometragem alvo"><em>km</em></div>
      <div id="m-due" class="hint" style="color:var(--ink-2);font-size:14px"></div>
    </div>
    <div class="stat-grid" id="m-kpis"></div>
    <div class="sec-head"><span>Idas à oficina</span><span class="muted" style="font-size:13px" id="m-hist-count"></span></div>
    <div class="list-card" id="m-hist"></div>`;

  document.body.insertAdjacentHTML(
    'beforeend',
    `<form class="sheet full" id="svc-sheet" novalidate aria-labelledby="svc-title">
      <div class="sheet-bar">
        <button type="button" class="text-btn" data-close style="justify-self:start">Cancelar</button>
        <h2 id="svc-title">Lançar manutenção</h2>
        <button type="button" class="text-btn danger" id="svc-del" hidden>Excluir</button>
      </div>
      <div class="sheet-body"><div class="stack">
        <div class="good" id="svc-check" hidden></div>
        <div class="warn-box" id="svc-warn" hidden></div>
        <div class="grid2">
          <label class="field">Data<input class="inp sm" id="svc-date" type="date"></label>
          <label class="field">Km na oficina<input class="inp sm" id="svc-km" inputmode="numeric" autocomplete="off"></label>
          <label class="field full">Oficina<input class="inp sm" id="svc-shop" autocomplete="off"></label>
          <label class="field">Nº da OS<input class="inp sm" id="svc-os" autocomplete="off" placeholder="Opcional"></label>
          <label class="field">Tipo<select class="inp sm" id="svc-type"><option value="revisao">Revisão</option><option value="corretiva">Conserto</option><option value="pneus">Pneus</option><option value="outros">Outros</option></select></label>
        </div>
        <div class="card-head"><span>Itens</span><span class="svc-total" id="svc-total"></span></div>
        <div id="svc-items" class="view" style="gap:10px"></div>
        <button type="button" class="btn" id="svc-add-item">+ Adicionar item</button>
        <label class="field">Observação<input class="inp sm" id="svc-note" autocomplete="off" placeholder="Opcional"></label>
        <div class="list-card"><div class="set-row"><div><div class="t">Anexo da OS</div><div class="d" id="svc-att-d"></div></div><div><button type="button" class="link-btn" id="svc-att-view" hidden>Ver</button><button type="button" class="link-btn" id="svc-att-add">Anexar</button></div></div></div>
        <input type="file" id="svc-att-file" accept="application/pdf,image/*" hidden>
        <div class="err" id="svc-err" hidden></div>
      </div></div>
      <div class="sheet-foot"><button type="submit" class="btn primary block">Salvar manutenção</button></div>
    </form>
    <datalist id="plan-list"></datalist>`,
  );
  document.querySelectorAll('#svc-sheet [data-close]').forEach((b) => b.addEventListener('click', c.closeSheets));

  /* ---------- render ---------- */
  let expanded = false;
  const SHOW_FIRST = 5;

  function render(d: MaintData) {
    data = d;
    const v = d.vehicle;
    $('m-car').textContent = v ? v.name + ' · ' + km(currentKmOf(v, d.logs, d.services)) + ' km' : '';
    if (!v) {
      $('m-next').innerHTML = '<div class="empty">Cadastre um carro para ver o plano de manutenção.</div>';
      ['m-alert', 'm-plan-note', 'm-kpis', 'm-hist'].forEach((id) => ($(id).innerHTML = ''));
      $('m-target-card').hidden = true;
      return;
    }
    const plan = planByKey(v.plan_key);
    const curKm = currentKmOf(v, d.logs, d.services);
    const today = c.todayISO();
    const kpd = kmPerDay(d.logs);
    const svcs = d.services.filter((s) => s.vehicle_id === v.id && !s.deleted_at).sort((a, b) => b.date.localeCompare(a.date));
    const itemsOf = (sid: string) => d.items.filter((i) => i.service_id === sid && !i.deleted_at);

    // OS aguardando leitura
    const pend = d.pending.filter((p) => p.vehicle_id === v.id && p.status === 'aguardando_leitura');
    $('m-pending').hidden = !pend.length;
    $('m-pending').innerHTML = pend
      .map(
        (p) =>
          '<div class="set-row"><div><div class="t">OS aguardando leitura</div><div class="d">' + esc(p.name) + ' · ' + dmy(p.created_at.slice(0, 10)) + '</div></div><div><button type="button" class="link-btn" data-read="' + esc(p.id) + '">Ler agora</button><button type="button" class="link-btn muted" data-discard="' + esc(p.id) + '">Descartar</button></div></div>',
      )
      .join('');

    if (!plan) {
      $('m-alert').innerHTML = '';
      $('m-next').innerHTML =
        '<div class="set-row col"><div><div class="t">Este carro ainda não tem plano de manutenção</div><div class="d">Escolha um plano para o app calcular as próximas trocas.</div></div><div class="btn-row"><select class="inp sm" id="m-plan-pick" aria-label="Plano">' +
        PLANS.map((p) => '<option value="' + esc(p.key) + '">' + esc(p.name) + '</option>').join('') +
        '</select><button type="button" class="btn primary" id="m-plan-use">Usar este plano</button></div></div>';
      $('m-more').hidden = true;
      $('m-plan-note').textContent = 'Para outros carros, a pesquisa de plano chega na próxima fase.';
      $('m-target-card').hidden = true;
    } else {
      const states = sortStates(itemStates(plan, lastDoneByKey(v.id, d.services, d.items), curKm, today, kpd));
      // Aviso no topo: o mais urgente que pede ação
      const venc = states.find((s) => s.status === 'vencida');
      const semHist = states.find((s) => s.status === 'sem_historico' && (s.item.interval_km || s.item.interval_months));
      const every = (it: ItemState['item']) => [it.interval_km ? km(it.interval_km) + ' km' : '', it.interval_months ? it.interval_months + ' meses' : ''].filter(Boolean).join(' ou ');
      $('m-alert').innerHTML = venc
        ? '<div class="alert bad">' + ICON.warn + '<div><b>' + esc(venc.item.description) + ' vencida</b><span>' + esc(dueText(venc)) + '. Agende a troca.</span></div></div>'
        : semHist
          ? '<div class="alert">' + ICON.warn + '<div><b>' + esc(semHist.item.description) + ' sem registro</b><span>O plano pede ' + (semHist.item.action === 'inspecionar' ? 'inspeção' : 'troca') + ' a cada ' + esc(every(semHist.item)) + '. Pergunte na próxima revisão.</span></div></div>'
          : '';
      const shown = expanded ? states : states.slice(0, SHOW_FIRST);
      $('m-next').innerHTML = shown.map((s) => planRow(s, curKm, today)).join('');
      $('m-more').hidden = states.length <= SHOW_FIRST;
      $('m-more').textContent = expanded ? 'Mostrar menos' : 'Ver o plano completo (' + states.length + ' itens)';
      $('m-plan-note').innerHTML =
        esc(plan.name) + '. ' + esc(plan.summary) + ' Fontes: ' + plan.sources.map((x) => '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.label) + '</a>').join(' · ');
      // Quando chegar em X km
      $('m-target-card').hidden = false;
      const tEl = $<HTMLInputElement>('m-target');
      const def = Math.ceil((curKm + 1) / 10000) * 10000;
      const tgt = targetKm && targetKm > curKm ? targetKm : def;
      if (document.activeElement !== tEl) tEl.value = String(tgt);
      const r = dueByKm(states, tgt, curKm, today, kpd);
      $('m-target-when').textContent = r.targetDate ? '≈ ' + monthYear(r.targetDate) + ' no seu ritmo' : '';
      const names = (list: ItemState[]) => list.map((x) => x.item.description.toLowerCase()).join(', ');
      const trocar = r.due.filter((x) => x.item.action === 'trocar');
      const insp = r.due.filter((x) => x.item.action === 'inspecionar');
      const lines = [trocar.length ? 'Trocar ' + names(trocar) : '', insp.length ? 'Inspecionar ' + names(insp) : '', r.check.length ? 'Verificar (sem registro): ' + names(r.check) : ''].filter(Boolean);
      $('m-due').innerHTML = lines.length ? lines.map((l) => '<div>' + esc(l.charAt(0).toUpperCase() + l.slice(1)) + '</div>').join('') : 'Nada do plano vence até ' + km(tgt) + ' km.';
    }

    // Indicadores de manutenção
    const since = new Date(today + 'T12:00:00Z');
    since.setUTCFullYear(since.getUTCFullYear() - 1);
    const t12 = maintenanceTotals(v.id, d.services, d.items, since.toISOString().slice(0, 10));
    $('m-kpis').innerHTML = [
      ['Gasto em 12 meses', brl(t12.total), pl(t12.visits, 'ida à oficina', 'idas à oficina')],
      ['Peças × mão de obra', brl(t12.parts), 'mão de obra ' + brl(t12.labor)],
    ]
      .map((k) => '<div class="stat"><span class="k">' + k[0] + '</span><span class="v">' + k[1] + '</span><span class="s">' + k[2] + '</span></div>')
      .join('');

    // Idas à oficina
    $('m-hist-count').textContent = pl(svcs.length, 'registro', 'registros');
    $('m-hist').innerHTML = svcs.length
      ? svcs
          .map((s) => {
            const its = itemsOf(s.id);
            const tot = its.reduce((a, i) => a + i.parts_brl + i.labor_brl, 0);
            const hasAtt = !!s.attachment_path || d.pending.some((p) => p.service_id === s.id);
            const sub = [dmy(s.date), s.odometer_km ? km(s.odometer_km) + ' km' : '', pl(its.length, 'item', 'itens')].filter(Boolean).join(' · ');
            return (
              '<button type="button" class="row" data-svc="' + esc(s.id) + '"><span class="ic svc">' + ICON.wrench + '</span>' +
              '<span class="mid"><span class="a">' + esc(TYPE_LABEL[s.type] + (s.shop ? ' · ' + s.shop : '')) + '</span><span class="b">' + esc(sub) + '</span></span>' +
              '<span class="end"><span class="a">' + brl(tot) + '</span><span class="b' + (hasAtt ? ' blue' : '') + '">' + (hasAtt ? 'OS anexada' : TYPE_LABEL[s.type]) + '</span></span></button>'
            );
          })
          .join('')
      : '<div class="empty">Nenhuma manutenção registrada.</div>';

    $('plan-list').innerHTML = (plan?.items ?? []).map((i) => '<option value="' + esc(i.description) + '"></option>').join('');
  }

  function dueText(s: ItemState): string {
    const parts: string[] = [];
    if (s.due_km != null) parts.push((s.remaining_km! <= 0 ? 'venceu em ' : '') + km(s.due_km) + ' km');
    if (s.due_date) parts.push((s.remaining_days! <= 0 ? 'venceu em ' : 'até ') + monthYear(s.due_date));
    if (s.status !== 'vencida' && s.est_date && s.due_km != null) parts.push('≈ ' + monthYear(s.est_date));
    return parts.join(' · ');
  }

  function planRow(s: ItemState, curKm: number, today: string): string {
    const it = s.item;
    let left: string;
    let right = '';
    if (s.status === 'sem_historico') {
      left = 'Sem registro no app';
      right = it.interval_km || it.interval_months ? 'a cada ' + [it.interval_km ? km(it.interval_km) + ' km' : '', it.interval_months ? it.interval_months + ' meses' : ''].filter(Boolean).join(' ou ') : it.note ?? '';
    } else if (s.status === 'sem_intervalo') {
      left = 'Feito em ' + dmy(s.last_date!);
      right = it.note ?? '';
    } else {
      if (s.remaining_km != null) left = s.remaining_km > 0 ? (it.action === 'inspecionar' ? 'Inspeção em ' : 'Faltam ') + km(s.remaining_km) + ' km' : 'Passou ' + km(-s.remaining_km) + ' km';
      else left = s.remaining_days != null && s.remaining_days > 0 ? 'Troca por tempo' : 'Venceu pelo tempo';
      right = dueText(s);
    }
    const pct = progressOf(s, curKm, today);
    const tags = (it.action === 'inspecionar' ? '<span class="tag">inspeção</span>' : '') + (it.preliminary ? '<span class="tag">a confirmar</span>' : '');
    return (
      '<div class="plan-row"><div class="h"><span class="n">' + esc(it.description) + tags + '</span><span class="chip ' + s.status + '">' + STATUS_LABEL[s.status] + '</span></div>' +
      (pct != null ? '<div class="bar ' + s.status + '"><i style="width:' + Math.round(pct * 100) + '%"></i></div>' : '') +
      '<div class="row-meta"><span>' + esc(left) + '</span><span>' + esc(right) + '</span></div></div>'
    );
  }

  /* ---------- ações da aba ---------- */
  $('v-manut').addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    const btn = el.closest<HTMLElement>('button');
    if (!btn) return;
    if (btn.id === 'm-new') return openService(null);
    if (btn.id === 'm-more') {
      expanded = !expanded;
      return render(data);
    }
    if (btn.id === 'm-import') {
      if (!data.vehicle) return toast('Cadastre o carro primeiro.');
      return $<HTMLInputElement>('m-file').click();
    }
    if (btn.id === 'm-plan-use' && data.vehicle) {
      const key = $<HTMLSelectElement>('m-plan-pick').value;
      await db.vehicles.put(stamp<Vehicle>({ ...data.vehicle, plan_key: key }));
      return toast('Plano aplicado a ' + data.vehicle.name);
    }
    if (btn.dataset.svc) return openService(btn.dataset.svc);
    if (btn.dataset.read) {
      const p = data.pending.find((x) => x.id === btn.dataset.read);
      if (p) return readFile(p.blob, p.name, p.id);
    }
    if (btn.dataset.discard) {
      if (btn.dataset.armed) {
        await db.pending_files.delete(btn.dataset.discard);
        return toast('OS descartada');
      }
      btn.dataset.armed = '1';
      btn.textContent = 'Confirmar';
    }
  });
  $('v-manut').addEventListener('input', (e) => {
    if ((e.target as HTMLElement).id !== 'm-target') return;
    const n = c.parseIntLoose((e.target as HTMLInputElement).value);
    targetKm = Number.isFinite(n) ? n : null;
    render(data);
  });

  $<HTMLInputElement>('m-file').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !data.vehicle) return;
    if (!/^(application\/pdf|image\/)/.test(file.type)) return toast('Escolha um PDF ou uma foto da OS.');
    const online = navigator.onLine !== false && !!(await currentSession());
    if (!online) {
      await savePending(file, file.name);
      return toast(navigator.onLine === false ? 'Sem internet: a OS fica guardada e você lê depois.' : 'Entre na conta (Mais › Conta) para ler a OS. Ela ficou guardada.');
    }
    await readFile(file, file.name, null);
  });

  async function savePending(blob: Blob, name: string): Promise<string> {
    const id = uuid();
    await db.pending_files.put({ id, vehicle_id: data.vehicle!.id, service_id: null, status: 'aguardando_leitura', name, type: blob.type, blob, created_at: new Date().toISOString() });
    return id;
  }

  let reading = false;
  async function readFile(blob: Blob, name: string, pendingId: string | null) {
    if (reading) return;
    if (navigator.onLine === false) return toast('Sem internet. Tente quando estiver conectado.');
    if (!(await currentSession())) return toast('Entre na conta (Mais › Conta) para ler a OS.');
    const v = data.vehicle!;
    const plan = planByKey(v.plan_key);
    reading = true;
    const btns = document.querySelectorAll<HTMLButtonElement>('#m-import, [data-read]');
    btns.forEach((b) => (b.disabled = true));
    toast('Lendo a OS… pode levar até 30 segundos.');
    try {
      const draft = await parseOS(blob, (plan?.items ?? []).map((i) => ({ key: i.key, description: i.description })), { name: v.name, make: v.make, model: v.model, year: v.year });
      openService(null, draft, { blob, name, type: blob.type, pendingId });
      toast(draft.warnings.length ? 'OS lida. Confira os avisos e os itens.' : 'OS lida. Confira os itens antes de salvar.');
    } catch (err) {
      if (!pendingId) await savePending(blob, name);
      toast((err as Error).message + ' A OS ficou guardada para tentar de novo.');
    } finally {
      reading = false;
      btns.forEach((b) => (b.disabled = false));
    }
  }

  /* ---------- formulário de manutenção ---------- */
  let editing: Service | null = null;
  let attach: { blob: Blob; name: string; type: string; pendingId: string | null } | null = null;
  let delArmed = false;

  function itemRow(it: { id: string; description: string; plan_item_key: string | null; parts_brl: number; labor_brl: number }) {
    const plan = planByKey(data.vehicle?.plan_key);
    const opts = '<option value="">Fora do plano</option>' + (plan?.items ?? []).map((p) => '<option value="' + esc(p.key) + '"' + (p.key === it.plan_item_key ? ' selected' : '') + '>' + esc(p.description) + '</option>').join('');
    const money = (n: number) => (n ? c.fmt(n, 2) : '');
    return (
      '<div class="item-row" data-id="' + esc(it.id) + '">' +
      '<div class="r1"><input class="inp sm" data-f="description" list="plan-list" placeholder="Descrição (ex.: Óleo 5W30)" value="' + esc(it.description) + '" aria-label="Descrição">' +
      '<button type="button" class="link-btn muted" data-rm aria-label="Remover item">Remover</button></div>' +
      '<select class="inp sm" data-f="plan" aria-label="Item do plano">' + opts + '</select>' +
      '<div class="grid2"><label class="field">Peça R$<input class="inp sm" data-f="parts" inputmode="decimal" value="' + money(it.parts_brl) + '"></label>' +
      '<label class="field">Mão de obra R$<input class="inp sm" data-f="labor" inputmode="decimal" value="' + money(it.labor_brl) + '"></label></div></div>'
    );
  }

  function readItems() {
    return [...document.querySelectorAll<HTMLElement>('#svc-items .item-row')].map((row) => {
      const q = (f: string) => row.querySelector<HTMLInputElement>('[data-f="' + f + '"]')!.value;
      const parts = c.parseNum(q('parts'));
      const labor = c.parseNum(q('labor'));
      return { id: row.dataset.id!, description: q('description').trim(), plan_item_key: q('plan') || null, parts_brl: Number.isFinite(parts) ? parts : 0, labor_brl: Number.isFinite(labor) ? labor : 0 };
    });
  }

  function updateTotal() {
    const its = readItems();
    const p = its.reduce((s, i) => s + i.parts_brl, 0);
    const l = its.reduce((s, i) => s + i.labor_brl, 0);
    $('svc-total').innerHTML = '<b>' + brl(p + l) + '</b> · peças ' + brl(p) + ' · m.o. ' + brl(l);
  }

  function renderAttach() {
    const hasRemote = !!editing?.attachment_path;
    const localPending = editing ? data.pending.find((p) => p.service_id === editing!.id) : null;
    const d = $('svc-att-d');
    if (attach) d.textContent = attach.name + (hasRemote ? ' (substitui o anexo atual)' : '');
    else if (localPending) d.textContent = localPending.name + ' · aguardando envio';
    else if (hasRemote) d.textContent = 'Guardada na nuvem';
    else d.textContent = 'Nenhum arquivo';
    $('svc-att-view').hidden = !(attach || localPending || hasRemote);
    $('svc-att-add').textContent = attach || localPending || hasRemote ? 'Trocar' : 'Anexar';
  }

  function openService(id: string | null, draft?: OsDraft, file?: { blob: Blob; name: string; type: string; pendingId: string | null }) {
    const v = data.vehicle;
    if (!v) return toast('Cadastre o carro primeiro.');
    editing = id ? data.services.find((s) => s.id === id) ?? null : null;
    attach = file ?? null;
    delArmed = false;
    const del = $('svc-del');
    del.hidden = !editing;
    del.classList.remove('armed');
    del.textContent = 'Excluir';
    $('svc-title').textContent = editing ? 'Editar manutenção' : draft ? 'Confira a OS lida' : 'Lançar manutenção';
    $('svc-err').hidden = true;
    const set = (i: string, val: unknown) => ($<HTMLInputElement>(i).value = val == null ? '' : String(val));
    const src = editing ?? draft;
    set('svc-date', src?.date ?? c.todayISO());
    set('svc-km', src?.odometer_km ?? '');
    set('svc-shop', src?.shop ?? '');
    set('svc-os', src?.os_number ?? '');
    set('svc-type', src?.type ?? 'revisao');
    set('svc-note', editing?.note ?? '');
    const lastShop = data.services.filter((s) => s.vehicle_id === v.id && !s.deleted_at && s.shop).sort((a, b) => b.date.localeCompare(a.date))[0]?.shop;
    $<HTMLInputElement>('svc-shop').placeholder = lastShop ?? 'Nome da oficina';
    const rows = editing
      ? data.items.filter((i) => i.service_id === editing!.id && !i.deleted_at).sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.description.localeCompare(b.description))
      : draft
        ? draft.items.map((i) => ({ id: uuid(), description: i.description + (i.quantity ? ' (' + i.quantity + ')' : ''), plan_item_key: i.plan_item_key, parts_brl: i.parts_brl, labor_brl: i.labor_brl }))
        : [{ id: uuid(), description: '', plan_item_key: null, parts_brl: 0, labor_brl: 0 }];
    $('svc-items').innerHTML = rows.map(itemRow).join('');
    const warn = $('svc-warn');
    const check = $('svc-check');
    check.hidden = true;
    if (draft) {
      const dt = draft.document_totals.total_brl;
      const sum = draft.totals.total_brl;
      if (dt != null && Math.abs(dt - sum) <= 0.01) {
        check.innerHTML = ICON.check + '<span>Soma dos itens <b>' + brl(sum) + '</b> = total da OS</span>';
        check.hidden = false;
      }
      const n = draft.warnings.length;
      warn.innerHTML = n
        ? '<b>' + (n === 1 ? '1 ponto para conferir' : n + ' pontos para conferir') + '</b><ul>' + draft.warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul>'
        : '<b>Lido da OS. Confira os itens antes de salvar.</b>';
      warn.hidden = false;
    } else warn.hidden = true;
    updateTotal();
    renderAttach();
    c.openSheet('svc-sheet');
  }

  $('svc-add-item').addEventListener('click', () => {
    $('svc-items').insertAdjacentHTML('beforeend', itemRow({ id: uuid(), description: '', plan_item_key: null, parts_brl: 0, labor_brl: 0 }));
    const rows = $('svc-items').querySelectorAll<HTMLInputElement>('[data-f="description"]');
    rows[rows.length - 1]?.focus();
  });
  $('svc-items').addEventListener('click', (e) => {
    const rm = (e.target as HTMLElement).closest('[data-rm]');
    if (rm) {
      rm.closest('.item-row')?.remove();
      updateTotal();
    }
  });
  $('svc-items').addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.f === 'description') {
      const plan = planByKey(data.vehicle?.plan_key);
      const match = plan?.items.find((i) => i.description.toLowerCase() === el.value.trim().toLowerCase());
      const sel = el.closest('.item-row')!.querySelector<HTMLSelectElement>('[data-f="plan"]')!;
      if (match && !sel.value) sel.value = match.key;
    }
    updateTotal();
  });

  $('svc-att-add').addEventListener('click', () => $<HTMLInputElement>('svc-att-file').click());
  $<HTMLInputElement>('svc-att-file').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) return toast('Arquivo grande demais (máximo 10 MB).');
    attach = { blob: f, name: f.name, type: f.type, pendingId: null };
    renderAttach();
  });
  $('svc-att-view').addEventListener('click', async () => {
    const localPending = editing ? data.pending.find((p) => p.service_id === editing!.id) : null;
    const blob = attach?.blob ?? localPending?.blob;
    try {
      const href = blob ? URL.createObjectURL(blob) : await attachmentUrl(editing!.attachment_path!);
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      toast((err as Error).message);
    }
  });

  $('svc-del').addEventListener('click', async () => {
    if (!editing) return;
    if (!delArmed) {
      delArmed = true;
      $('svc-del').classList.add('armed');
      $('svc-del').textContent = 'Confirmar';
      return;
    }
    const sid = editing.id;
    await softDelete(db.services, sid);
    for (const it of data.items.filter((i) => i.service_id === sid && !i.deleted_at)) await softDelete(db.service_items, it.id);
    await db.pending_files.where('service_id').equals(sid).delete();
    c.closeSheets();
    toast('Manutenção excluída');
  });

  $('svc-sheet').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = data.vehicle!;
    const err = (m: string) => {
      $('svc-err').textContent = m;
      $('svc-err').hidden = false;
    };
    const val = (i: string) => $<HTMLInputElement>(i).value.trim();
    const date = val('svc-date');
    if (!date) return err('Informe a data.');
    const kmv = c.parseIntLoose(val('svc-km'));
    const items = readItems().filter((i) => i.description || i.parts_brl || i.labor_brl);
    if (!items.length) return err('Adicione pelo menos um item.');
    if (items.some((i) => !i.description)) return err('Dê uma descrição a cada item.');
    const sid = editing?.id ?? uuid();
    const svc = stamp<Service>({
      id: sid,
      vehicle_id: editing?.vehicle_id ?? v.id,
      date,
      odometer_km: Number.isFinite(kmv) ? kmv : null,
      shop: val('svc-shop').slice(0, 80) || null,
      os_number: val('svc-os').slice(0, 40) || null,
      type: val('svc-type') as Service['type'],
      note: val('svc-note').slice(0, 300) || null,
      attachment_path: editing?.attachment_path ?? null,
    });
    const keep = new Set(items.map((i) => i.id));
    const old = editing ? data.items.filter((i) => i.service_id === sid && !i.deleted_at) : [];
    await db.transaction('rw', db.services, db.service_items, db.pending_files, async () => {
      await db.services.put(svc);
      for (const [position, it] of items.entries()) {
        const prev = old.find((o) => o.id === it.id);
        await db.service_items.put(
          stamp<ServiceItem>({
            id: it.id,
            service_id: sid,
            description: it.description.slice(0, 160),
            plan_item_key: it.plan_item_key,
            parts_brl: Math.round(it.parts_brl * 100) / 100,
            labor_brl: Math.round(it.labor_brl * 100) / 100,
            next_due_km: prev?.next_due_km ?? null,
            next_due_date: prev?.next_due_date ?? null,
            position,
          }),
        );
      }
      for (const o of old) if (!keep.has(o.id)) await softDelete(db.service_items, o.id);
      if (attach) {
        await db.pending_files.where('service_id').equals(sid).delete();
        if (attach.pendingId) await db.pending_files.update(attach.pendingId, { status: 'anexo', service_id: sid });
        else await db.pending_files.put({ id: uuid(), vehicle_id: svc.vehicle_id, service_id: sid, status: 'anexo', name: attach.name, type: attach.type, blob: attach.blob, created_at: new Date().toISOString() });
      }
    });
    c.closeSheets();
    toast(editing ? 'Manutenção atualizada' : 'Manutenção salva');
  });

  return { render, openService: (id: string) => openService(id) };
}
