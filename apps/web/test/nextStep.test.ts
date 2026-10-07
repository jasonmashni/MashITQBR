import { describe, expect, it } from 'vitest';
import { deliverableGuard, deriveSteps, lockNotice, nextStep, primaryStep, readyToFinalize } from '../src/pages/workspace/nextStep.js';
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

  it('readyToFinalize only when every earlier step is done and there is no final lock', () => {
    const all = meta({ status: 'scheduled', meeting: { scheduledAt: '2026-10-01T15:00:00Z' }, packageSentAt: '2026-10-02T00:00:00Z' });
    const steps = deriveSteps({ hasData: true, unfiled: 0, meta: all, disc: disc(['discussed']), now: NOW });
    expect(nextStep(steps)?.key).toBe('finalize');
    expect(readyToFinalize(steps)).toBe(true);
    // A completed quarter without its final package still has Finalize to do.
    const completed = deriveSteps({ hasData: true, unfiled: 0, meta: { ...all, status: 'completed' }, disc: disc(['discussed']), now: NOW });
    expect(nextStep(completed)?.key).toBe('finalize');
    expect(completed[completed.length - 1]?.action).toBe('Finalize');
  });

  it('a pre-read lock marks Send package done', () => {
    const locked = meta({ status: 'narrative_approved', locks: { preread: { at: '2026-10-02T00:00:00Z', by: 'jason', version: 1 } } });
    const steps = deriveSteps({ hasData: true, unfiled: 0, meta: locked, disc: null, now: NOW });
    expect(steps.find((s) => s.key === 'send')?.done).toBe(true);
  });

  it('a final lock reads Finalized and leaves nothing next', () => {
    const lock = { at: '2026-10-03T00:00:00Z', by: 'jason', version: 2 };
    const final = meta({ status: 'dispositioned', packageSentAt: '2026-10-02T00:00:00Z', locks: { preread: { ...lock, version: 1 }, final: lock } });
    const steps = deriveSteps({ hasData: true, unfiled: 0, meta: final, disc: disc(['discussed']), now: NOW });
    const last = steps[steps.length - 1]!;
    expect(last.key).toBe('finalize');
    expect(last.label).toBe('Finalized');
    expect(last.done).toBe(true);
    expect(nextStep(steps)).toBeUndefined();
    expect(readyToFinalize(steps)).toBe(false);
  });
});

describe('primaryStep / lockNotice', () => {
  it('Finalize is the primary action once the quarter is completed without a final lock', () => {
    const completed = meta({ status: 'completed' });
    const steps = deriveSteps({ hasData: true, unfiled: 0, meta: completed, disc: null, now: NOW });
    expect(nextStep(steps)?.key).not.toBe('finalize');
    expect(primaryStep(steps, completed)?.key).toBe('finalize');
  });

  it('describes each lock in one sentence', () => {
    expect(lockNotice(meta())).toBeUndefined();
    expect(lockNotice(meta({ locks: { preread: { at: '2026-10-02T12:00:00Z', by: 'j', version: 1 } } }))).toMatch(
      /^Pre-read sent on .+\. Data and narrative are locked; the agenda is open until decisions are captured\.$/,
    );
    expect(lockNotice(meta({ locks: { final: { at: '2026-10-02T12:00:00Z', by: 'j', version: 2 } } }))).toMatch(/^Final package stored on .+\. Read-only\.$/);
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
