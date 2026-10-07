import { describe, expect, it } from 'vitest';
import { metaFromPeriodList, qbrLoadError } from '../src/pages/workspace/landing.js';

const lock = { at: '2026-07-01T00:00:00Z', by: 'jason', version: 1 };

describe('metaFromPeriodList', () => {
  it('carries the status and locks of the quarter from the period list', () => {
    const list = [
      { period: '2026-Q3', hasSnapshot: true, status: 'scheduled', locks: { preread: lock } },
      { period: '2026-Q2', hasSnapshot: true, status: 'dispositioned', locks: { preread: lock, final: { ...lock, version: 2 } } },
    ];
    expect(metaFromPeriodList(list, 'anp', '2026-Q2')).toEqual({
      clientId: 'anp',
      period: '2026-Q2',
      status: 'dispositioned',
      locks: { preread: lock, final: { ...lock, version: 2 } },
    });
  });

  it('is undefined for a quarter that is not in the list or not locked', () => {
    expect(metaFromPeriodList([{ period: '2026-Q3', hasSnapshot: true }], 'anp', '2026-Q3')).toBeUndefined();
    expect(metaFromPeriodList([], 'anp', '2026-Q3')).toBeUndefined();
  });
});

describe('qbrLoadError', () => {
  it('a 404 is an empty state, not an error', () => {
    expect(qbrLoadError(404, 'No metric snapshot')).toBeNull();
  });

  it('a 503 says the stored package is missing and how to recover', () => {
    expect(qbrLoadError(503, 'Stored package missing; reopen to rebuild.')).toEqual({
      title: 'Stored package missing',
      text: 'The stored package for this quarter is missing. Reopen the quarter to rebuild it.',
    });
  });

  it('anything else keeps the build failure copy', () => {
    expect(qbrLoadError(500, 'Boom')).toEqual({
      title: 'Could not build the report',
      text: "Boom. Try a Sync, or check the client's tool mappings on the Integrations page.",
    });
  });
});
