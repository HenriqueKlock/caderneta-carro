import { db, type FuelLog, type Service, type ServiceItem, type Vehicle } from './db';

export const BACKUP_APP = 'caderneta-carro';
export const BACKUP_VERSION = 1;

export interface Backup {
  app: typeof BACKUP_APP;
  version: number;
  exported_at: string;
  vehicles: Vehicle[];
  fuel_logs: FuelLog[];
  services: Service[];
  service_items: ServiceItem[];
}

export async function exportBackup(): Promise<Backup> {
  const strip = <T extends { _dirty: 0 | 1 }>(rows: T[]) => rows.map(({ _dirty, ...r }) => r as unknown as T);
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    vehicles: strip(await db.vehicles.toArray()),
    fuel_logs: strip(await db.fuel_logs.toArray()),
    services: strip(await db.services.toArray()),
    service_items: strip(await db.service_items.toArray()),
  };
}

export interface ImportResult {
  vehicles: number;
  fuel_logs: number;
  services: number;
  service_items: number;
}

/**
 * Importa um backup: insere ou atualiza por id. Quando a mesma linha existe dos dois lados,
 * fica a de `updated_at` mais recente. Tudo entra marcado para subir na próxima sincronização.
 */
export async function importBackup(raw: unknown): Promise<ImportResult> {
  const b = raw as Partial<Backup>;
  if (!b || b.app !== BACKUP_APP || typeof b.version !== 'number') {
    throw new Error('Este arquivo não é um backup da Caderneta do Carro.');
  }
  if (b.version > BACKUP_VERSION) {
    throw new Error('Backup criado por uma versão mais nova do app. Atualize o app e tente de novo.');
  }
  const res: ImportResult = { vehicles: 0, fuel_logs: 0, services: 0, service_items: 0 };
  await db.transaction('rw', [db.vehicles, db.fuel_logs, db.services, db.service_items], async () => {
    for (const name of ['vehicles', 'fuel_logs', 'services', 'service_items'] as const) {
      const rows = (b[name] ?? []) as Array<{ id: string; updated_at: string }>;
      const table = db[name] as any;
      for (const r of rows) {
        if (!r || typeof r.id !== 'string') continue;
        const cur = await table.get(r.id);
        if (cur && cur.updated_at >= r.updated_at) continue;
        await table.put({ deleted_at: null, ...r, _dirty: 1 });
        res[name]++;
      }
    }
  });
  return res;
}
