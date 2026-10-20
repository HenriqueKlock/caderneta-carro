import { createClient, type Session } from '@supabase/supabase-js';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config';
import { db, getMeta, now, setMeta } from './db';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  // Login pelo link do e-mail: o Supabase devolve a sessão no fragmento (#access_token=…) da URL do app
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit', storageKey: 'caderneta-auth' },
});

/** Ordem pai → filho: o banco recusa um filho cujo pai ainda não subiu. */
export const TABLES = ['vehicles', 'fuel_logs', 'services', 'service_items'] as const;
type TableName = (typeof TABLES)[number];

const PUSH_CHUNK = 200;
const PULL_PAGE = 1000;
/** Margem de segurança no pull: relê 5 min antes do último marco (aplicar de novo é inofensivo). */
const PULL_OVERLAP_MS = 5 * 60 * 1000;

export type SyncStatus =
  | { kind: 'signed-out' }
  | { kind: 'offline' }
  | { kind: 'syncing' }
  | { kind: 'ok'; at: string }
  | { kind: 'error'; message: string };

let status: SyncStatus = { kind: 'signed-out' };
const listeners = new Set<(s: SyncStatus) => void>();
export function onSyncStatus(fn: (s: SyncStatus) => void) {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}
function emit(s: SyncStatus) {
  status = s;
  listeners.forEach((fn) => fn(s));
}

const NUMERIC: Partial<Record<TableName, string[]>> = {
  fuel_logs: ['liters', 'total_brl', 'price_per_l'],
  service_items: ['parts_brl', 'labor_brl'],
};

function toRemote(t: TableName, row: Record<string, any>) {
  const { _dirty, ...r } = row;
  if (t === 'vehicles') r.archived = !!r.archived;
  return r;
}

function fromRemote(t: TableName, row: Record<string, any>): Record<string, any> {
  const { user_id, server_updated_at, ...r } = row;
  if (t === 'vehicles') r.archived = r.archived ? 1 : 0;
  for (const k of NUMERIC[t] ?? []) if (r[k] != null) r[k] = Number(r[k]);
  // timestamps vêm do Postgres com offset; normaliza para ISO em UTC, igual ao que o app grava
  for (const k of ['updated_at', 'deleted_at']) if (r[k]) r[k] = new Date(r[k]).toISOString();
  return { ...r, _dirty: 0 as const };
}

function friendly(err: unknown): string {
  const e = err as { message?: string; code?: string };
  const msg = e?.message ?? String(err);
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Sem conexão com o servidor';
  if (/JWT|token/i.test(msg)) return 'Sessão expirada; entre de novo';
  return msg;
}

async function push(t: TableName) {
  const table = db[t] as any;
  const rows: Record<string, any>[] = await table.where('_dirty').equals(1).toArray();
  for (let i = 0; i < rows.length; i += PUSH_CHUNK) {
    const chunk = rows.slice(i, i + PUSH_CHUNK);
    const { error } = await supabase.from(t).upsert(chunk.map((r) => toRemote(t, r)), { onConflict: 'id' });
    if (error) throw error;
    // Só limpa a marca se a linha não mudou enquanto o envio acontecia
    await db.transaction('rw', table, async () => {
      for (const r of chunk) {
        const cur = await table.get(r.id);
        if (cur && cur.updated_at === r.updated_at) await table.update(r.id, { _dirty: 0 });
      }
    });
  }
}

async function pull(t: TableName) {
  const table = db[t] as any;
  const key = 'last_pull_' + t;
  const last = await getMeta<string | null>(key, null);
  let since = last ? new Date(Date.parse(last) - PULL_OVERLAP_MS).toISOString() : '1970-01-01T00:00:00Z';
  let newest = last;
  for (;;) {
    const { data, error } = await supabase.from(t).select('*').gt('server_updated_at', since).order('server_updated_at').limit(PULL_PAGE);
    if (error) throw error;
    if (!data.length) break;
    await db.transaction('rw', table, async () => {
      for (const remote of data) {
        const local = await table.get(remote.id);
        const incoming = fromRemote(t, remote);
        // Vence a alteração mais recente; uma edição local ainda não enviada e mais nova fica
        if (local && local._dirty && local.updated_at > incoming.updated_at) continue;
        await table.put(incoming);
      }
    });
    since = data[data.length - 1].server_updated_at;
    if (!newest || Date.parse(since) > Date.parse(newest)) newest = since;
    if (data.length < PULL_PAGE) break;
  }
  if (newest && newest !== last) await setMeta(key, newest);
}

let running: boolean = false;
let again: boolean = false;

/** Envia o que mudou no aparelho e recebe o que mudou na nuvem. Pode ser chamada à vontade. */
export async function sync(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  const session = await currentSession();
  if (!session) return emit({ kind: 'signed-out' });
  if (navigator.onLine === false) return emit({ kind: 'offline' });

  // Um aparelho com dados de outra conta não sincroniza: os dados iriam para a conta errada
  const owner = await getMeta<string | null>('owner_user_id', null);
  if (owner && owner !== session.user.id) {
    return emit({ kind: 'error', message: 'Este aparelho tem dados de outra conta. Exporte um backup e entre com a conta original.' });
  }

  running = true;
  emit({ kind: 'syncing' });
  try {
    await uploadAttachments(session.user.id);
    for (const t of TABLES) await push(t);
    for (const t of TABLES) await pull(t);
    if (!owner) await setMeta('owner_user_id', session.user.id);
    const at = new Date().toISOString();
    await setMeta('last_sync_at', at);
    emit({ kind: 'ok', at });
  } catch (err) {
    console.error('sync', err);
    emit(!(navigator.onLine as boolean) ? { kind: 'offline' } : { kind: 'error', message: friendly(err) });
  } finally {
    running = false;
    if (again) {
      again = false;
      setTimeout(sync, 0);
    }
  }
}

export async function currentSession(): Promise<Session | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session;
  } catch {
    return null;
  }
}

/* ---------- login sem senha pelo e-mail ---------- */
/** URL para onde o link do e-mail volta: a raiz do app publicado (ou o servidor local em desenvolvimento). */
export const APP_URL = location.origin + import.meta.env.BASE_URL;

/** Envia o e-mail de acesso. Com o modelo padrão do Supabase ele traz um link; com SMTP próprio pode trazer código. */
export async function sendLoginEmail(email: string) {
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: APP_URL } });
  if (error) throw new Error(/rate|seconds/i.test(error.message) ? 'Aguarde um minuto antes de pedir outro código.' : error.message);
}

export async function verifyCode(email: string, token: string) {
  const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw new Error(/expired|invalid/i.test(error.message) ? 'Código inválido ou expirado. Peça um novo.' : error.message);
}

export async function signOut() {
  await supabase.auth.signOut({ scope: 'local' });
  emit({ kind: 'signed-out' });
}

/* ---------- gatilhos ---------- */
let debounce: number | undefined;
export function scheduleSync(delay = 2000) {
  clearTimeout(debounce);
  debounce = window.setTimeout(sync, delay);
}

export function startAutoSync() {
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN') scheduleSync(0);
    if (event === 'SIGNED_OUT') emit({ kind: 'signed-out' });
  });
  window.addEventListener('online', () => scheduleSync(500));
  window.addEventListener('offline', () => status.kind !== 'signed-out' && emit({ kind: 'offline' }));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && scheduleSync(500));
  setInterval(() => document.visibilityState === 'visible' && sync(), 5 * 60 * 1000);
  scheduleSync(300);
}

/* ---------- anexos de OS (Storage) ---------- */
const EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };

/** Sobe os arquivos já ligados a uma manutenção salva e grava o caminho no registro. */
async function uploadAttachments(uid: string) {
  const files = await db.pending_files.where('status').equals('anexo').toArray();
  for (const f of files) {
    if (!f.service_id) continue;
    const svc = await db.services.get(f.service_id);
    if (!svc || svc.deleted_at) {
      await db.pending_files.delete(f.id);
      continue;
    }
    const path = uid + '/' + f.service_id + '.' + (EXT[f.type] ?? 'bin');
    const { error } = await supabase.storage.from('os').upload(path, f.blob, { upsert: true, contentType: f.type });
    if (error) throw error;
    await db.transaction('rw', db.services, db.pending_files, async () => {
      await db.services.update(f.service_id!, { attachment_path: path, updated_at: now(), _dirty: 1 });
      await db.pending_files.delete(f.id);
    });
  }
}

/** Link temporário para abrir o anexo guardado na nuvem. */
export async function attachmentUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from('os').createSignedUrl(path, 300);
  if (error || !data) throw new Error('Não consegui abrir o anexo agora.');
  return data.signedUrl;
}

/* ---------- leitura de OS ---------- */
export interface OsDraftItem { description: string; quantity: string | null; plan_item_key: string | null; parts_brl: number; labor_brl: number }
export interface OsDraft {
  date: string | null;
  odometer_km: number | null;
  shop: string | null;
  os_number: string | null;
  type: 'revisao' | 'corretiva' | 'pneus' | 'outros';
  items: OsDraftItem[];
  totals: { parts_brl: number; labor_brl: number; total_brl: number };
  document_totals: { parts_brl: number | null; labor_brl: number | null; total_brl: number | null };
  warnings: string[];
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('Não consegui ler o arquivo.'));
    r.readAsDataURL(blob);
  });
}

export async function parseOS(
  file: Blob,
  plan_items: { key: string; description: string }[],
  vehicle: { name?: string | null; make?: string | null; model?: string | null; year?: number | null },
): Promise<OsDraft> {
  if (file.size > 10 * 1024 * 1024) throw new Error('Arquivo grande demais (máximo 10 MB).');
  const { data, error } = await supabase.functions.invoke('parse-os', {
    body: { file_base64: await toBase64(file), media_type: file.type, plan_items, vehicle },
  });
  if (error) {
    let msg = 'Não consegui ler a OS agora.';
    try {
      const body = await (error as any).context?.json?.();
      if (body?.error) msg = body.error;
    } catch {
      /* resposta sem corpo */
    }
    if (/Failed to fetch|NetworkError/i.test(String((error as any).message))) msg = 'Sem conexão com o servidor.';
    throw new Error(msg);
  }
  return (data as { draft: OsDraft }).draft;
}
