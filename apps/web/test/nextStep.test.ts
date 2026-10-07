import { describe, expect, it } from 'vitest';
import { deliverableGuard, deriveSteps, nextStep, readyToComplete } from '../src/pages/workspace/nextStep.js';
import type { Discussion, QbrMeta } from '../src/types.js';

const meta = (over: Partial<QbrMeta> = {}): QbrMeta => ({ clientId: 'anp', period: '2026-Q4', status: 'draft', ...over });
const disc = (statuses: string[]): Discussion => ({ clientId: 'anp', period: '2026-Q4', items: statuses.map((status, i) => ({ id: `d${i}`, topic: `t${i}`, status })) as Discussion['items'] });
const NOW = Date.parse('2026-10-06T15:00:00Z');

describe('deriveSteps / nextStep', () => {
  it('starts at Sync data when there is no data', () => {
    const steps = deriveSteps({ hasData: false, unfiled: 0, disc: null, now: NOW });
    expect(nextStep(steps)?.key).toBe('sync');
    expect(steps.every((s) => !s.done)).toBe(true);
  });

  it('walks sync, reports, narrative, schedule in order', () => {
    expect(nextStep(deriveSteps({ hasData: true, unfiled: 2, disc: null, now: NOW }))?.key).toBe('reports');
    expect(nextStep(deriveSteps({ hasData: true, unfiled: 0, meta: meta({ status: 'data_synced' }), disc: null, now: NOW }))?.key).toBe('narrative');
    expect(nextStep(deriveSteps({ hasData: true, unfiled: 0, meta: meta({ status: 'narrative_approved' }), disc: null, now: NOW }))?.key).toBe('schedule');
  });

  it('a meeting whose time passed is NOT held until something was captured', () => {
    const booked = meta({ status: 'scheduled', meeting: { scheduledAt: '2026-10-01T15:00:00Z' } });
    const passed = deriveSteps({ hasData: true, unfiled: 0, meta: booked, disc: disc(['planned']), now: NOW });
    expect(nextStep(passed)?.key).toBe('meet');
    expect(passed.find((s) => s.key === 'meet')?.desc).toMatch(/time passed/);
    const captured = deriveSteps({ hasData: true, unfiled: 0, meta: booked, disc: disc(['discussed']), now: NOW });
    expect(nextStep(captured)?.key).toBe('send');
  });

  it('a skipped meeting satisfies both schedule and meet', () => {
    const skipped = meta({ status: 'narrative_approved', meetingSkipped: { at: '2026-10-02T00:00:00Z' } });
    expect(nextStep(deriveSteps({ hasData: true, unfiled: 0, meta: skipped, disc: null, now: NOW }))?.key).toBe('send');
  });

  it('readyToComplete only when every earlier step is done and the quarter is open', () => {
    const all = meta({ status: 'scheduled', meeting: { scheduledAt: '2026-10-01T15:00:00Z' }, packageSentAt: '2026-10-02T00:00:00Z' });
    const steps = deriveSteps({ hasData: true, unfiled: 0, meta: all, disc: disc(['discussed']), now: NOW });
    expect(nextStep(steps)?.key).toBe('complete');
    expect(readyToComplete(steps)).toBe(true);
    const closed = deriveSteps({ hasData: true, unfiled: 0, meta: { ...all, status: 'completed' }, disc: disc(['discussed']), now: NOW });
    expect(nextStep(closed)).toBeUndefined();
    expect(readyToComplete(closed)).toBe(false);
  });
});

describe('deliverableGuard', () => {
  it('locks until data, verification and approval are all in', () => {
    expect(deliverableGuard({ hasQbr: false, verificationOk: true, status: 'narrative_approved' }).reason).toBe('Sync data first');
    expect(deliverableGuard({ hasQbr: true, verificationOk: false, status: 'narrative_approved' }).reason).toMatch(/verification/);
    expect(deliverableGuard({ hasQbr: true, verificationOk: true, status: 'data_synced' }).reason).toBe('Approve the narrative first');
  });
  it('low confidence warns but does not lock', () => {
    const g = deliverableGuard({ hasQbr: true, verificationOk: true, status: 'scheduled', confidence: 'low' });
    expect(g.ok).toBe(true);
    expect(g.warning).toMatch(/Not enough security data/);
    expect(deliverableGuard({ hasQbr: true, verificationOk: true, status: 'completed', confidence: 'high' })).toEqual({ ok: true });
  });
});
