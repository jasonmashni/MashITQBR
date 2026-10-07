import { describe, expect, it } from 'vitest';
import type { QbrRecord } from '../src/store/index.js';
import { dataLocked, isFinal, LOCKED } from '../src/locks.js';

const base: QbrRecord = { clientId: 'c1', period: '2026-Q2', status: 'scheduled', updatedAt: '2026-06-01T00:00:00Z' };
const lock = { at: '2026-06-01T00:00:00Z', by: 'jason', version: 1 };

describe('lock helpers', () => {
  it('dataLocked is true once any lock exists', () => {
    expect(dataLocked(undefined)).toBe(false);
    expect(dataLocked(base)).toBe(false);
    expect(dataLocked({ ...base, locks: {} })).toBe(false);
    expect(dataLocked({ ...base, locks: { preread: lock } })).toBe(true);
    expect(dataLocked({ ...base, locks: { final: lock } })).toBe(true);
  });

  it('isFinal is false until locks.final exists', () => {
    expect(isFinal(undefined)).toBe(false);
    expect(isFinal({ ...base, locks: { preread: lock } })).toBe(false);
    expect(isFinal({ ...base, locks: { preread: lock, final: lock } })).toBe(true);
  });

  it('LOCKED answers 409 with the stage', () => {
    expect(LOCKED('preread')).toEqual({ status: 409, json: { error: 'locked', stage: 'preread' } });
  });
});
