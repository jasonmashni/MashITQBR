import { getDataStore } from './store/index.js';
import { currentActor } from './requestContext.js';

/** Fire-and-forget compliance audit entry; a storage hiccup never fails the mutation. */
export function audit(action: string, target: string, detail?: string): Promise<void> {
  return getDataStore()
    .appendAudit({
      id: Math.random().toString(36).slice(2, 10),
      at: new Date().toISOString(),
      actor: currentActor(),
      action,
      target,
      detail,
    })
    .catch(() => undefined);
}
