import { describe, it, expect } from 'vitest';
import { SEED_CLIENTS, findSeedSnapshot } from '@mashit/core';
import {
  buildAllowedNumbers,
  buildNarrativeInput,
  generateNarrative,
  type NarrativeModel,
  type NarrativeOutput,
} from '@mashit/narrative';

const anp = SEED_CLIENTS.find((c) => c.id === 'anp')!;
const input = buildNarrativeInput({
  client: anp,
  current: findSeedSnapshot('anp', '2026-Q1')!,
  previous: findSeedSnapshot('anp', '2025-Q4')!,
});

const clean: NarrativeOutput = {
  headline: 'A high-activity, security-forward quarter',
  summary_paragraphs: ['Ticket volume rose to 141, up 200% from 47 last quarter.'],
  highlights: ['22 email threats blocked before reaching inboxes'],
  recommendations: ['Plan the May hardware refresh'],
  figures_referenced: [
    { label: 'tickets this quarter', value: '141' },
    { label: 'tickets last quarter', value: '47' },
    { label: 'ticket change', value: '+200%' },
    { label: 'email threats blocked', value: '22' },
  ],
};

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
      expect(messages.some((m) => m.content.includes('NOT present'))).toBe(true);
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
});
