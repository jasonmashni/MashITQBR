import { describe, it, expect } from 'vitest';
import { SEED_CLIENTS, findSeedSnapshot } from '@mashit/core';
import {
  buildAllowedNumbers,
  buildNarrativeInput,
  generateNarrative,
  parseModelText,
  type NarrativeInput,
  type NarrativeModel,
  type NarrativeOutput,
} from '@mashit/narrative';
import { v4 } from './v4.js';

const anp = SEED_CLIENTS.find((c) => c.id === 'anp')!;
const input = buildNarrativeInput({
  client: anp,
  current: findSeedSnapshot('anp', '2026-Q1')!,
  previous: findSeedSnapshot('anp', '2025-Q4')!,
});

const clean: NarrativeOutput = v4({
  headline: 'A high-activity, security-forward quarter',
  lede: 'Ticket volume rose to 141, up 200% from 47 last quarter.',
  did: ['Blocked 22 email threats before reaching inboxes.', 'Handled every support request.', 'Kept monitoring running.'],
  plan: { now: [], next: [{ action: 'Plan the May hardware refresh', owner: 'Mash IT', decision: true }], later: [] },
  figures_referenced: [
    { label: 'tickets this quarter', value: '141' },
    { label: 'tickets last quarter', value: '47' },
    { label: 'ticket change', value: '+200%' },
    { label: 'email threats blocked', value: '22' },
  ],
});

const fabricated: NarrativeOutput = {
  ...clean,
  // 88,888 appears nowhere in the metric bundle, so it must be flagged.
  figures_referenced: [...clean.figures_referenced, { label: 'devices audited', value: '88,888' }],
};

describe('buildAllowedNumbers', () => {
  it('includes current values and computed deltas', () => {
    const allowed = new Set(buildAllowedNumbers(input));
    expect(allowed.has(141)).toBe(true); // current tickets
    expect(allowed.has(47)).toBe(true); // previous tickets
    expect(allowed.has(94)).toBe(true); // delta abs
    expect(allowed.has(200)).toBe(true); // delta pct
    expect(allowed.has(2026)).toBe(true); // period year, never flagged
  });

  it('takes insight figures from the insight data, never from subject text', () => {
    const bare: NarrativeInput = {
      client: { name: 'X' },
      period: { id: '2026-Q3', label: 'Q3 2026' },
      metrics: [],
      trends: [],
      scorecard: { overall: { score: null, rating: 'unknown', coverage: 0, confidence: 'low' }, functions: [], remediations: [] },
      ticketInsights: [
        { title: 'Windows 11 rollout', detail: 'Replace Lenovo P73 for 7 users', severity: 'medium', figures: [4] },
      ],
    };
    const allowed = new Set(buildAllowedNumbers(bare));
    expect(allowed.has(4)).toBe(true);
    expect(allowed.has(11)).toBe(false);
    expect(allowed.has(73)).toBe(false);
    expect(allowed.has(7)).toBe(false);
  });

  it('buildNarrativeInput carries each insight figures list', () => {
    const withInsights = buildNarrativeInput({
      client: anp,
      current: {
        clientId: 'anp',
        period: '2026-Q3',
        capturedAt: '2026-09-30T00:00:00Z',
        metrics: [{ key: 'sla.breaches', label: 'SLA breaches', value: 4, source: 'halo', category: 'operations' }],
      },
    });
    expect(withInsights.ticketInsights?.[0]?.figures).toEqual([4]);
  });
});

describe('generateNarrative', () => {
  it('returns immediately when the first draft verifies', async () => {
    let calls = 0;
    const model: NarrativeModel = async () => {
      calls++;
      return clean;
    };
    const result = await generateNarrative(input, model);
    expect(result.attempts).toBe(1);
    expect(result.verification.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it('regenerates with a correction after a fabricated figure, then succeeds', async () => {
    let calls = 0;
    const model: NarrativeModel = async (messages) => {
      calls++;
      // Second call should have received the rejected draft + correction.
      if (calls === 1) return fabricated;
      expect(messages.some((m) => m.content.includes('failed review'))).toBe(true);
      return clean;
    };
    const result = await generateNarrative(input, model, { maxRetries: 2 });
    expect(result.attempts).toBe(2);
    expect(result.verification.ok).toBe(true);
  });

  it('gives up after maxRetries and reports the failure', async () => {
    const model: NarrativeModel = async () => fabricated;
    const result = await generateNarrative(input, model, { maxRetries: 2 });
    expect(result.attempts).toBe(3); // initial + 2 retries
    expect(result.verification.ok).toBe(false);
    expect(result.verification.failures[0]!.unmatched).toContain(88888);
  });

  it('retries when prose cites an unverifiable figure', async () => {
    const outputs: NarrativeOutput[] = [{ ...clean, headline: 'Resolved 9,999 tickets', figures_referenced: [] }, clean];
    let i = 0;
    const model: NarrativeModel = async () => outputs[i++]!;
    const r = await generateNarrative(input, model, { maxRetries: 2 });
    expect(r.attempts).toBe(2);
    expect(r.verification.ok).toBe(true);
  });
});

describe('model output validation', () => {
  it('rejects output that does not match the narrative shape', async () => {
    const model = (async () => ({ headline: 'x' })) as unknown as NarrativeModel;
    await expect(generateNarrative(input, model)).rejects.toThrow(/shape/);
  });

  it('rejects a list holding a non-string', async () => {
    const model = (async () => ({ ...clean, did: [42] })) as unknown as NarrativeModel;
    await expect(generateNarrative(input, model)).rejects.toThrow(/shape/);
  });

  it('treats a negative maxRetries as zero (one attempt)', async () => {
    let calls = 0;
    const model: NarrativeModel = async () => {
      calls++;
      return fabricated;
    };
    const result = await generateNarrative(input, model, { maxRetries: -3 });
    expect(calls).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.verification.ok).toBe(false);
  });

  it('treats a non-numeric maxRetries as the default of 2', async () => {
    let calls = 0;
    const model: NarrativeModel = async () => {
      calls++;
      return fabricated;
    };
    const result = await generateNarrative(input, model, { maxRetries: Number.NaN });
    expect(calls).toBe(3);
    expect(result.attempts).toBe(3);
  });

  it('parseModelText includes stop_reason when the body is not JSON', () => {
    expect(() => parseModelText('{"headline": "cut off', 'max_tokens')).toThrow(/stop_reason: max_tokens/);
    expect(() => parseModelText('not json', null)).toThrow(/did not return valid JSON/);
  });

  it('parseModelText returns a valid narrative and shape-checks it', () => {
    expect(parseModelText(JSON.stringify(clean), 'end_turn')).toEqual(clean);
    expect(() => parseModelText('{"headline":"x"}', 'end_turn')).toThrow(/shape/);
  });

  it('a draft over a limit is retried with the limits in the correction', async () => {
    const long = { ...clean, did: ['a', 'b'] };
    const seen: string[] = [];
    let calls = 0;
    const model: NarrativeModel = async (messages) => {
      seen.push(messages[messages.length - 1]!.content);
      return calls++ === 0 ? long : clean;
    };
    const r = await generateNarrative(input, model, { maxRetries: 1 });
    expect(r.attempts).toBe(2);
    expect(r.verification.ok).toBe(true);
    expect(seen[1]).toContain('did: 2 items (3 to 4)');
  });
});
