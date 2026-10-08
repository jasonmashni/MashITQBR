import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-edits-'));
  process.env['QBR_DATA_DIR'] = dir;
  delete process.env['AzureWebJobsStorage'];
  delete process.env['ANTHROPIC_API_KEY'];
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['QBR_DATA_DIR'];
});

type Model = {
  executive: { lede?: string; did: string[]; saw: string[] };
  decisions: Array<{ ask: string; by?: string }>;
  plan: { now: Array<{ action: string; owner: string; decision?: boolean }>; next: unknown[]; later: unknown[] };
  protection: Array<{ id: string; inPlace?: string; thisQuarter?: string }>;
};

const body = {
  lede: 'Edited opening paragraph.',
  did: ['Edited did one.', 'Edited did two.', 'Edited did three.'],
  saw: ['Edited saw one.', 'Edited saw two.', 'Edited saw three.'],
  decisions: [{ ask: 'Approve the refresh', by: 'Nov 15' }],
  plan: { now: [{ action: 'Fix the lab PC backup', owner: 'Mash IT', decision: true }], next: [], later: [] },
  protection: [
    { question: 'get_in', inPlace: 'Edited in place.', thisQuarter: 'Edited this quarter.' },
    { question: 'know', inPlace: 'Watched.', thisQuarter: 'Quiet.' },
    { question: 'recover', inPlace: 'Backed up.', thisQuarter: 'Restores tested.' },
    { question: 'keep_up', inPlace: 'Patched.', thisQuarter: 'Current.' },
    { question: 'run_well', inPlace: 'Reviewed.', thisQuarter: 'Held.' },
  ],
};

describe('narrative edits round trip through the handlers', () => {
  it('saves every v4 field and the rebuilt model shows them', async () => {
    const h = await import('../src/handlers.js');
    const res = await h.putNarrativeEdits('anp', '2026-Q1', body);
    expect(res.status).toBe(200);
    const state = (await h.getNarrativeState('anp', '2026-Q1')).json as { edits: Record<string, unknown> };
    expect(state.edits['did']).toEqual(body.did);
    expect(state.edits['plan']).toEqual(body.plan);

    const qbr = (await h.getQbr('anp', '2026-Q1', '0')).json as { model: Model };
    const m = qbr.model;
    expect(m.executive.lede).toBe('Edited opening paragraph.');
    expect(m.executive.did).toEqual(body.did);
    expect(m.executive.saw).toEqual(body.saw);
    expect(m.decisions).toEqual(body.decisions);
    expect(m.plan.now).toEqual(body.plan.now);
    expect(m.protection.find((p) => p.id === 'get_in')).toMatchObject({ inPlace: 'Edited in place.', thisQuarter: 'Edited this quarter.' });
  });

  it('a second save that changes one field keeps the others the body still carries', async () => {
    const h = await import('../src/handlers.js');
    await h.putNarrativeEdits('anp', '2026-Q1', { ...body, lede: 'Second opening paragraph.' });
    const m = ((await h.getQbr('anp', '2026-Q1', '0')).json as { model: Model }).model;
    expect(m.executive.lede).toBe('Second opening paragraph.');
    expect(m.executive.did).toEqual(body.did);
    expect(m.decisions).toEqual(body.decisions);
    expect(m.plan.now).toEqual(body.plan.now);
  });

  it('an emptied decisions list and plan clear them on the model', async () => {
    const h = await import('../src/handlers.js');
    await h.putNarrativeEdits('anp', '2026-Q1', { ...body, decisions: [], plan: { now: [], next: [], later: [] } });
    const m = ((await h.getQbr('anp', '2026-Q1', '0')).json as { model: Model }).model;
    expect(m.decisions).toEqual([]);
    expect(m.plan).toEqual({ now: [], next: [], later: [] });
    expect(m.executive.did).toEqual(body.did);
  });
});
