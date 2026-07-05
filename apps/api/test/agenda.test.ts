import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReportModel } from '@mashit/report';
import type { Client, MetricSnapshot } from '@mashit/core';
import { buildAgendaContext, offlineAgenda } from '../src/agenda.js';

const client: Client = { id: 'anp', name: 'ANP Enertech', industry: 'Manufacturing', complianceStandard: 'TISAX' };

function snap(period: string, metrics: MetricSnapshot['metrics']): MetricSnapshot {
  return { clientId: 'anp', period, capturedAt: `${period}-01T00:00:00.000Z`, metrics };
}

const current = snap('2026-Q2', [
  { key: 'tickets.total', label: 'Total tickets', value: 62, source: 'halo', category: 'operations', higherIsBetter: false },
  { key: 'assets.warranty_expired', label: 'Devices out of warranty', value: 10, source: 'hudu', category: 'infrastructure', higherIsBetter: false },
  { key: 'identity.mfa_coverage_pct', label: 'MFA coverage', value: 82, unit: '%', source: 'cipp', category: 'identity', higherIsBetter: true },
  { key: 'backup.failed_jobs', label: 'Failed backup jobs', value: 3, source: 'dropsuite', category: 'backup', higherIsBetter: false },
]);
const previous = snap('2026-Q1', [
  { key: 'tickets.total', label: 'Total tickets', value: 20, source: 'halo', category: 'operations', higherIsBetter: false },
]);

describe('agenda suggestions', () => {
  it('extracts movers, weak functions and headline metrics from the model', () => {
    const model = buildReportModel({ client, current, previous });
    const ctx = buildAgendaContext(model);
    expect(ctx.clientName).toBe('ANP Enertech');
    expect(ctx.complianceStandard).toBe('TISAX');
    // tickets tripled → a mover is present
    expect(ctx.movers.find((m) => m.label === 'Total tickets')?.deltaPct).toBeGreaterThan(0);
    expect(ctx.metrics.map((m) => m.key)).toEqual(
      expect.arrayContaining(['assets.warranty_expired', 'identity.mfa_coverage_pct', 'backup.failed_jobs']),
    );
  });

  it('offline suggestions are data-driven, capped at 3, and cite figures', () => {
    const model = buildReportModel({ client, current, previous });
    const out = offlineAgenda(buildAgendaContext(model));
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(3);
    const blob = out.map((s) => `${s.topic} ${s.rationale}`).join(' ');
    expect(blob).toMatch(/warranty|refresh/i); // 10 out-of-warranty devices surfaces
    expect(blob).toMatch(/10|82|3/); // real figures cited, nothing invented
  });

  it('handler falls back to offline suggestions without an AI key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qbr-agenda-'));
    process.env['QBR_DATA_DIR'] = dir;
    delete process.env['AzureWebJobsStorage'];
    const saved = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const h = await import('../src/handlers.js');
      const store = (await import('../src/store/index.js')).getDataStore();
      await store.upsertClient(client);
      await store.putSnapshot(current);
      await store.putSnapshot(previous);
      const res = await h.suggestQbrAgenda('anp', '2026-Q2');
      expect(res.status).toBe(200);
      const body = res.json as { suggestions: Array<{ topic: string }>; source: string };
      expect(body.source).toBe('offline');
      expect(body.suggestions.length).toBeGreaterThan(0);
    } finally {
      if (saved) process.env['ANTHROPIC_API_KEY'] = saved;
      delete process.env['QBR_DATA_DIR'];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
