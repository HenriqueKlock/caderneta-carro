import Dexie, { type Table } from 'dexie';

/** Campos comuns a toda tabela sincronizável. `_dirty` = 1 enquanto a linha não subiu para a nuvem. */
export interface SyncFields {
  id: string;
  updated_at: string;
  deleted_at: string | null;
  _dirty: 0 | 1;
}

export type FuelType = 'gasolina' | 'etanol' | 'diesel' | 'gnv';
export type VehicleFuel = 'flex' | 'gasolina' | 'etanol' | 'diesel';

export interface Vehicle extends SyncFields {
  name: string;
  make: string | null;
  model: string | null;
  year: number | null;
  engine: string | null;
  fuel_type: VehicleFuel;
  initial_km: number | null;
  plan_key: string | null;
  archived: 0 | 1;
}

export interface FuelLog extends SyncFields {
  vehicle_id: string;
  date: string; // YYYY-MM-DD
  odometer_km: number;
  liters: number;
  total_brl: number;
  price_per_l: number;
  fuel: FuelType;
  full_tank: boolean;
  range_left_km: number | null;
  station: string | null;
  note: string | null;
}

export interface Service extends SyncFields {
  vehicle_id: string;
  date: string;
  odometer_km: number | null;
  shop: string | null;
  os_number: string | null;
  type: 'revisao' | 'corretiva' | 'pneus' | 'outros';
  note: string | null;
}

export interface ServiceItem extends SyncFields {
  service_id: string;
  description: string;
  plan_item_key: string | null;
  parts_brl: number;
  labor_brl: number;
  next_due_km: number | null;
  next_due_date: string | null;
}

export interface Meta {
  key: string;
  value: unknown;
}

export class AppDB extends Dexie {
  vehicles!: Table<Vehicle, string>;
  fuel_logs!: Table<FuelLog, string>;
  services!: Table<Service, string>;
  service_items!: Table<ServiceItem, string>;
  meta!: Table<Meta, string>;

  constructor() {
    super('caderneta-carro');
    this.version(1).stores({
      vehicles: 'id, _dirty, updated_at',
      fuel_logs: 'id, vehicle_id, [vehicle_id+odometer_km], _dirty, updated_at',
      services: 'id, vehicle_id, _dirty, updated_at',
      service_items: 'id, service_id, _dirty, updated_at',
      meta: 'key',
    });
  }
}

export const db = new AppDB();

export const now = () => new Date().toISOString();
export const uuid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db.meta.get(key);
  return row ? (row.value as T) : fallback;
}
export async function setMeta(key: string, value: unknown) {
  await db.meta.put({ key, value });
}

/** Grava marcando como pendente de envio. */
export function stamp<T extends SyncFields>(row: Omit<T, 'updated_at' | '_dirty' | 'deleted_at'> & Partial<SyncFields>): T {
  return { deleted_at: null, ...row, updated_at: now(), _dirty: 1 } as T;
}

/** Exclusão lógica: a linha some das telas e a exclusão sobe para a nuvem na sincronização. */
export async function softDelete(table: Table<any, string>, id: string) {
  await table.update(id, { deleted_at: now(), updated_at: now(), _dirty: 1 });
}
