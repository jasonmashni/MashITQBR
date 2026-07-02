import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context so framework-agnostic handlers can attribute audit
 * entries without threading the HTTP request through every signature.
 */
const als = new AsyncLocalStorage<{ actor: string }>();

export function runWithActor<T>(actor: string, fn: () => Promise<T>): Promise<T> {
  return als.run({ actor }, fn);
}

export function currentActor(): string {
  return als.getStore()?.actor ?? 'system';
}
