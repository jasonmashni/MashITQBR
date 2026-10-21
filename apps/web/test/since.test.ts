import { describe, expect, it } from 'vitest';
import { carriedItem, clearSinceOverride, overridesForSave, setSinceOverride, sinceRowsForPanel } from '../src/pages/workspace/since.js';
import type { DiscussionItem, SinceRow } from '../src/types.js';

const row = (over: Partial<SinceRow>): SinceRow => ({ id: 'a', topic: 'SSO rollout', computed: 'in_progress', effective: 'in_progress', ...over });

describe('sinceRowsForPanel', () => {
  it('shows the computed status as the choice until an override is set, closed as Dropped', () => {
    const rows = sinceRowsForPanel([row({}), row({ id: 'b', computed: 'closed', effective: 'closed' }), row({ id: 'c', computed: 'waiting', effective: 'waiting' })], undefined, []);
    expect(rows.map((r) => [r.id, r.choice, r.effective, r.canCarry])).toEqual([
      ['a', 'in_progress', 'in_progress', true],
      ['b', 'dropped', 'closed', false],
      ['c', 'waiting', 'waiting', true],
    ]);
  });

  it('the local override wins and sets the note; done and dropped cannot be carried', () => {
    const rows = sinceRowsForPanel(
      [row({}), row({ id: 'b' })],
      { a: { status: 'done', note: 'Live in August', at: 'x', by: 'y' }, b: { status: 'waiting', at: 'x', by: 'y' } },
      [],
    );
    expect(rows[0]).toMatchObject({ choice: 'done', effective: 'done', note: 'Live in August', canCarry: false });
    expect(rows[1]).toMatchObject({ choice: 'waiting', effective: 'waiting', note: '', canCarry: true });
  });

  it('hides Carry once the row is on this agenda', () => {
    const agenda: DiscussionItem[] = [{ id: 'n', topic: 'SSO rollout', source: 'carried', sourceRef: 'a' }];
    const [r] = sinceRowsForPanel([row({})], undefined, agenda);
    expect(r).toMatchObject({ carried: true, canCarry: false });
  });
});

describe('setSinceOverride', () => {
  it('starts from the shown choice when only the note changes, and trims nothing while typing', () => {
    const shown = sinceRowsForPanel([row({ computed: 'waiting', effective: 'waiting' })], undefined, [])[0]!;
    const next = setSinceOverride(undefined, shown, { note: 'Waiting on ' });
    expect(next).toMatchObject({ a: { status: 'waiting', note: 'Waiting on ' } });
    const again = setSinceOverride(next, { ...shown, choice: 'waiting', note: 'Waiting on ' }, { status: 'dropped' });
    expect(again['a']).toMatchObject({ status: 'dropped', note: 'Waiting on ' });
  });
});

describe('carriedItem', () => {
  it('copies the topic as a planned carried item that lands on the report', () => {
    expect(carriedItem(row({}), false, 'n1')).toEqual({
      id: 'n1',
      topic: 'SSO rollout',
      status: 'planned',
      disposition: 'pending',
      includeInReport: true,
      source: 'carried',
      sourceRef: 'a',
      sourceTopic: 'SSO rollout',
    });
  });
  it('keeps a HIPAA client item off the report until rewritten', () => {
    expect(carriedItem(row({}), true, 'n1').includeInReport).toBe(false);
  });
});

describe('clearSinceOverride (Reset)', () => {
  it('deletes the key so the row shows the computed status again', () => {
    const o = { a: { status: 'done' as const, at: 'x', by: 'y' }, b: { status: 'waiting' as const, at: 'x', by: 'y' } };
    const next = clearSinceOverride(o, 'a');
    expect(next).toEqual({ b: o.b });
    expect(o.a).toBeDefined();
    expect(sinceRowsForPanel([row({ computed: 'waiting', effective: 'done', override: o.a })], next, [])[0]).toMatchObject({ choice: 'waiting', overridden: false });
    expect(sinceRowsForPanel([row({})], o, [])[0]!.overridden).toBe(true);
  });
});

describe('overridesForSave', () => {
  it('drops keys GET since did not return', () => {
    const o = { a: { status: 'done' as const, at: 'x', by: 'y' }, stale: { status: 'waiting' as const, at: 'x', by: 'y' } };
    expect(overridesForSave(o, [row({})])).toEqual({ a: o.a });
    expect(overridesForSave(undefined, [row({})])).toBeUndefined();
    // Until GET since answers, send what was loaded.
    expect(overridesForSave(o, null)).toEqual(o);
  });
});
