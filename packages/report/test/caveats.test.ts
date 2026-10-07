import { describe, it, expect } from 'vitest';
import { SEED_CLIENTS, findSeedSnapshot } from '@mashit/core';
import { buildPdfDefinition, buildReportModel, clientCaveats, renderReportHtml } from '@mashit/report';

const anp = SEED_CLIENTS.find((c) => c.id === 'anp')!;
const none = { excludedKeys: new Set<string>(), hiddenCategories: new Set<string>() };

const SAMPLED = '[halo] Halo: ticket tallies counted from the first 200 of 1,400 in-period tickets.';
const INTERNAL = [
  '[cipp] CIPP ListMFAUsers failed: CIPP responded 401 Unauthorized',
  "No integrations mapped for this client — configure connections and set the client's external ids.",
  '[huntress] NinjaOne: no devices in this organization carry the selected device roles — check the connection’s "Device roles" picker.',
  '[huntress] Huntress summary reports unavailable: Huntress responded 429',
];

describe('clientCaveats', () => {
  it('keeps count caveats and strips the source tag', () => {
    expect(clientCaveats([SAMPLED], none)).toEqual(['Halo: ticket tallies counted from the first 200 of 1,400 in-period tickets.']);
  });

  it('drops HTTP errors, setup instructions and source-tagged setup notes', () => {
    expect(clientCaveats(INTERNAL, none)).toEqual([]);
  });

  it('replaces em dashes with commas and cuts error text after "unavailable:"', () => {
    const out = clientCaveats(
      ['[ninja] NinjaOne patches query truncated at 500 rows (page cap reached) — the figure is a lower bound.'],
      none,
    );
    expect(out).toEqual(['NinjaOne patches query truncated at 500 rows (page cap reached), the figure is a lower bound.']);
    expect(out.join(' ')).not.toContain('—');
  });

  it('drops carry-over notes that name a metric key', () => {
    expect(clientCaveats(['Metric "security.mfa_coverage" from manual was replaced by the synced value, partial.'], none)).toEqual([]);
  });

  it('drops caveats about excluded metrics and hidden categories', () => {
    const spend = '[halo] Halo: spend read from the first 50 of 120 invoices (newest first) — quarterly spend may be understated.';
    expect(clientCaveats([spend], none)).toHaveLength(1);
    expect(clientCaveats([spend], { ...none, hiddenCategories: new Set(['spend']) })).toEqual([]);
    const patch = '[ninja] NinjaOne patch success rate not reported: the install history was truncated at the page cap.';
    expect(clientCaveats([patch], none)).toHaveLength(1);
    expect(clientCaveats([patch], { ...none, excludedKeys: new Set(['patch.success_pct']), excludedLabels: new Set(['Patch success rate']) })).toEqual([]);
    const mfa = '[cipp] MFA coverage not measured for 3 shared mailboxes.';
    expect(clientCaveats([mfa], { ...none, excludedKeys: new Set(['identity.mfa_coverage_pct']) })).toEqual([]);
  });
});

describe('client deliverables carry only client caveats', () => {
  const current = { ...findSeedSnapshot('anp', '2026-Q1')!, warnings: [...INTERNAL, SAMPLED] };
  const m = buildReportModel({ client: anp, current, previous: findSeedSnapshot('anp', '2025-Q4')! });

  it('keeps operator diagnostics out of the HTML and PDF', () => {
    const html = renderReportHtml(m);
    const pdf = JSON.stringify(buildPdfDefinition(m));
    for (const out of [html, pdf]) {
      expect(out).not.toContain('401 Unauthorized');
      expect(out).not.toContain('responded 429');
      expect(out).not.toContain('No integrations mapped');
      expect(out).not.toContain('[huntress]');
      expect(out).not.toContain('Device roles');
      expect(out).toContain('counted from the first 200 of 1,400');
      expect(out).not.toContain('[halo]');
    }
  });
});

describe('clientCaveats residuals from the final review', () => {
  it('never prints a tenant scope or raw response fields, even inside a kept caveat', () => {
    const out = clientCaveats(
      [
        'Check Point returned no email events for 2026-07-01 to 2026-09-30 (scope acme-tenant-42) — email security metrics not reported; confirm the tenant mapping.',
        'Check Point returned no email events in a recognized format (response fields: foo, bar) — email security metrics not reported.',
      ],
      none,
    );
    expect(out.join(' ')).not.toMatch(/acme-tenant-42|scope|response fields|foo/);
    expect(out.length).toBe(2);
    expect(out[0]).toMatch(/metrics not reported/);
  });

  it('keeps an "understated" caveat the client should read', () => {
    const out = clientCaveats(['2 Halo contract(s) had no recognizable monthly value field — MRR may be understated.'], none);
    expect(out).toEqual(['2 Halo contract(s) had no recognizable monthly value field, MRR may be understated.']);
  });
});
