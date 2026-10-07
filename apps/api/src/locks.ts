import type { ApiResult } from './handlers.js';
import { getDataStore, type PackageStage, type QbrRecord } from './store/index.js';

/**
 * Lock 1 (`preread`, package sent) freezes data and narrative. Lock 2
 * (`final`, decisions captured or Finalize) freezes the agenda too.
 */
export function dataLocked(record: QbrRecord | undefined): boolean {
  return !!(record?.locks?.preread || record?.locks?.final);
}

export function isFinal(record: QbrRecord | undefined): boolean {
  return !!record?.locks?.final;
}

export const LOCKED = (stage: PackageStage): ApiResult => ({ status: 409, json: { error: 'locked', stage } });

/**
 * The 409 a write must answer when the quarter is locked at `level`, else
 * undefined. `data` writes stop at either lock; `final` writes (agenda,
 * schedule) stop only at lock 2.
 */
export async function refuseIfLocked(clientId: string, period: string, level: 'data' | 'final'): Promise<ApiResult | undefined> {
  const record = await getDataStore().getQbr(clientId, period);
  const locked = level === 'data' ? dataLocked(record) : isFinal(record);
  if (!locked) return undefined;
  return LOCKED(record?.locks?.final ? 'final' : 'preread');
}
