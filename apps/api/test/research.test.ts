import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@mashit/core';
import type { ResearchModel } from '../src/research.js';

const client: Client = { id: 'anp', name: 'ANP Enertech', industry: 'Manufacturing', goals: [{ id: 'g1', title: 'Grow output', status: 'planned' }] };

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-research-'));
  process.env['QBR_DATA_DIR'] = dir;
  delete process.env['AzureWebJobsStorage'];
});
afterAll(() => {
  delete process.env['QBR_DATA_DIR'];
  rmSync(dir, { recursive: true, force: true });
});

describe('researchClient handler', () => {
  it('runs the researcher and returns its trends + suggestions', async () => {
    const h = await import('../src/handlers.js');
    const store = (await import('../src/store/index.js')).getDataStore();
    await store.upsertClient(client);

    let seenGoals: string[] = [];
    const fake: ResearchModel = async (input) => {
      seenGoals = input.existingGoals;
      return {
        summary: `${input.clientName} is a ${input.industry} firm.`,
        trends: [{ title: 'EV supply-chain shift', insight: 'Battery sourcing is localizing.', relevance: 'Drives new OT security needs.', sourceUrl: 'https://example.com/ev' }],
        suggestedGoals: [{ title: 'Harden OT network', alignment: 'We segment and monitor the plant network.' }],
        recommendations: ['Review OT/IT segmentation this quarter.'],
        sourced: true,
      };
    };
    const res = await h.researchClient('anp', fake);
    expect(res.status).toBe(200);
    const body = res.json as { available: boolean; research?: { trends: unknown[]; suggestedGoals: unknown[]; sourced: boolean } };
    expect(body.available).toBe(true);
    expect(body.research?.trends).toHaveLength(1);
    expect(body.research?.suggestedGoals).toHaveLength(1);
    expect(body.research?.sourced).toBe(true);
    // The client's existing goals are passed so the researcher avoids duplicating them.
    expect(seenGoals).toEqual(['Grow output']);
  });

  it('404s for an unknown client', async () => {
    const h = await import('../src/handlers.js');
    const res = await h.researchClient('nope', async () => ({ summary: '', trends: [], suggestedGoals: [], recommendations: [], sourced: false }));
    expect(res.status).toBe(404);
  });

  it('returns available:false when AI is off and no researcher is supplied', async () => {
    const saved = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const h = await import('../src/handlers.js');
      const res = await h.researchClient('anp');
      expect(res.status).toBe(200);
      expect((res.json as { available: boolean }).available).toBe(false);
    } finally {
      if (saved) process.env['ANTHROPIC_API_KEY'] = saved;
    }
  });
});
