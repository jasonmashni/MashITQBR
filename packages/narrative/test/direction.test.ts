import { describe, expect, it } from 'vitest';
import { findSeedSnapshot, SEED_CLIENTS } from '@mashit/core';
import { buildNarrativeInput, buildUserContent, SYSTEM_PROMPT } from '@mashit/narrative';

const client = SEED_CLIENTS.find((c) => c.id === 'anp')!;
const current = findSeedSnapshot('anp', '2026-Q1')!;

describe('narrative direction', () => {
  it('is omitted from the input (and the cache key) when empty', () => {
    const bare = buildNarrativeInput({ client, current });
    expect(bare.direction).toBeUndefined();
    const empty = buildNarrativeInput({ client, current, direction: { focus: undefined, sectionGuidance: {} } });
    expect(empty.direction).toBeUndefined();
  });

  it('rides into the prompt when set — so changing it regenerates', () => {
    const input = buildNarrativeInput({
      client,
      current,
      direction: { focus: 'business continuity', sectionGuidance: { backup: 'we re-tuned what we measure — not a decline' } },
    });
    expect(input.direction?.focus).toBe('business continuity');
    const content = buildUserContent(input);
    expect(content).toContain('business continuity');
    expect(content).toContain('re-tuned what we measure');
  });

  it('carries the client compliance standard for light-touch framing', () => {
    const input = buildNarrativeInput({ client: { ...client, complianceStandard: 'TISAX' }, current });
    expect(input.client.complianceStandard).toBe('TISAX');
    expect(SYSTEM_PROMPT).toContain('complianceStandard');
    expect(SYSTEM_PROMPT).toContain('Measurement changes are not business trends');
  });
});
