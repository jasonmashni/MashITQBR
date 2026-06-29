import { describe, it, expect } from 'vitest';
import { SEED_CLIENTS, findSeedSnapshot, previousPeriod } from '@mashit/core';
import { buildAllowedNumbers, buildNarrativeInput, draftOfflineNarrative, verifyFigures } from '@mashit/narrative';

describe('draftOfflineNarrative', () => {
  for (const client of SEED_CLIENTS) {
    it(`produces a self-verifying narrative for ${client.id}`, () => {
      const current = findSeedSnapshot(client.id, '2026-Q1')!;
      const previous = findSeedSnapshot(client.id, previousPeriod('2026-Q1').id);
      const input = buildNarrativeInput({ client, current, previous });
      const draft = draftOfflineNarrative(input);

      // Every figure it cites must be traceable — verification must pass.
      const result = verifyFigures(draft.figures_referenced, buildAllowedNumbers(input));
      expect(result.ok).toBe(true);
      expect(draft.headline).toContain('2026');
      expect(draft.summary_paragraphs.length).toBeGreaterThan(0);
    });
  }
});
