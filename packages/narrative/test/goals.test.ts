import { describe, expect, it } from 'vitest';
import { findSeedSnapshot, SEED_CLIENTS, type ClientGoal } from '@mashit/core';
import { buildNarrativeInput, buildUserContent, SYSTEM_PROMPT } from '@mashit/narrative';

const client = SEED_CLIENTS.find((c) => c.id === 'anp')!;
const current = findSeedSnapshot('anp', '2026-Q1')!;

const goals: ClientGoal[] = [
  { id: 'g1', title: 'Open two new clinics', alignment: 'Sizing rollout per site.', status: 'on_track', targetPeriod: '2026-Q4' },
  { id: 'g2', title: '  ', status: 'planned' }, // blank — dropped
];

describe('client goals in the narrative input', () => {
  it('is omitted when the client has no goals', () => {
    expect(buildNarrativeInput({ client, current }).goals).toBeUndefined();
  });

  it('carries qualitative goals (dropping blanks) into the input and the prompt', () => {
    const input = buildNarrativeInput({ client: { ...client, goals }, current });
    expect(input.goals).toHaveLength(1);
    expect(input.goals![0]!.title).toBe('Open two new clinics');
    const content = buildUserContent(input);
    expect(content).toContain('Open two new clinics');
  });

  it('the system prompt instructs the model to ground the summary in strategic goals', () => {
    expect(SYSTEM_PROMPT).toContain('Strategic goals');
  });
});
