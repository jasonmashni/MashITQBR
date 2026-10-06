import { describe, it, expect } from 'vitest';
import type { MetricTrend } from '@mashit/core';
import { SEED_CLIENTS, findSeedSnapshot } from '@mashit/core';
import { buildReportModel, moversBarChartSvg, selectKpiTiles, selectMovers } from '@mashit/report';

const trend = (
  key: string,
  current: number,
  previous: number,
  sentiment: MetricTrend['sentiment'],
): MetricTrend => ({
  key,
  label: key,
  category: 'security',
  current,
  previous,
  deltaAbs: current - previous,
  deltaPct: previous === 0 ? null : Math.round(((current - previous) / previous) * 1000) / 10,
  direction: current > previous ? 'up' : current < previous ? 'down' : 'flat',
  sentiment,
});

describe('selectMovers', () => {
  it('keeps only good/bad movers, biggest change first, and excludes telemetry', () => {
    const movers = selectMovers([
      trend('huntress.siem_logs', 90_000, 40_000, 'negative'), // excluded by key
      trend('endpoints.av_coverage_pct', 99, 90, 'positive'), // +10%
      trend('tickets.total', 141, 47, 'negative'), // +200%
      trend('devices.count', 30, 28, 'neutral'), // neutral — not chartable
      trend('identity.mfa_coverage_pct', 92, 80, 'positive'), // +15%
    ]);
    expect(movers.map((m) => m.label)).toEqual(['tickets.total', 'identity.mfa_coverage_pct', 'endpoints.av_coverage_pct']);
    expect(movers.every((m) => m.deltaText)).toBe(true);
    // Sentiment drives the good/bad split, not raw direction.
    expect(movers.find((m) => m.label === 'tickets.total')!.good).toBe(false);
    expect(movers.find((m) => m.label === 'identity.mfa_coverage_pct')!.good).toBe(true);
  });

  it('renders extreme swings as honest movement, never a screaming percent or a → glyph', () => {
    const movers = selectMovers([
      trend('vuln.critical', 62, 3, 'negative'), // ~+1966% → "3 to 62"
      trend('email.threats_blocked', 40, 22, 'positive'),
    ]);
    const extreme = movers.find((m) => m.label === 'vuln.critical')!;
    expect(extreme.deltaText).toBe('3 to 62');
    expect(extreme.deltaText).not.toContain('→');
  });
});

describe('moversBarChartSvg', () => {
  it('returns empty when fewer than two movers exist', () => {
    expect(moversBarChartSvg([trend('a', 5, 4, 'positive')])).toBe('');
    expect(moversBarChartSvg([])).toBe('');
  });

  it('draws a self-contained diverging SVG with both status colours, a legend, and no unsafe glyphs', () => {
    const svg = moversBarChartSvg([
      trend('tickets.total', 141, 47, 'negative'),
      trend('identity.mfa_coverage_pct', 92, 80, 'positive'),
      trend('email.threats_blocked', 40, 22, 'positive'),
    ]);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('#0e7c72'); // improved (teal, the shared "good")
    expect(svg).toContain('#b42318'); // needs attention (red, the shared "act")
    expect(svg).toContain('Improved');
    expect(svg).toContain('Needs attention');
    expect(svg).toContain('<rect');
    // WinAnsi safety — the PDF wraps this same string in an svg node.
    expect(svg).not.toContain('→');
    expect(svg).not.toContain('▲');
    expect(svg).not.toContain('▼');
  });
});

describe('selectKpiTiles', () => {
  it('leads with the maturity score, then real headline metrics', () => {
    const model = buildReportModel({
      client: SEED_CLIENTS.find((c) => c.id === 'anp')!,
      current: findSeedSnapshot('anp', '2026-Q1')!,
      previous: findSeedSnapshot('anp', '2025-Q4')!,
    });
    const tiles = selectKpiTiles(model);
    expect(tiles.length).toBeGreaterThanOrEqual(2);
    expect(tiles[0]!.label).toMatch(/^Security maturity/);
    expect(tiles[0]!.note).toMatch(/of controls measured/);
    // The rest are drawn from the metric sections (headline candidates).
    expect(tiles.slice(1).every((t) => t.value !== '—')).toBe(true);
    // The tickets tile carries its movement in words, WinAnsi-safe.
    const tickets = tiles.find((t) => t.label === 'Tickets handled')!;
    expect(tickets.note).toBe('up from 47');
    expect(tickets.noteTone).toBe('bad');
  });

  it('says "Not scored" instead of a number when confidence is low', () => {
    const model = buildReportModel({
      client: SEED_CLIENTS.find((c) => c.id === 'anp')!,
      current: { clientId: 'anp', period: '2026-Q2', capturedAt: '2026-06-30T00:00:00Z', metrics: [
        { key: 'tickets.total', label: 'Total tickets', value: 12, source: 'halo', category: 'operations' },
      ] },
    });
    const tiles = selectKpiTiles(model);
    expect(tiles[0]!.value).toBe('Not scored');
    expect(tiles[0]!.label).toBe('Security maturity');
  });
});
