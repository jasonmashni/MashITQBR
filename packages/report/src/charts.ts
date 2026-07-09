import type { MetricTrend } from '@mashit/core';
import { formatValue, ratingColor, trendDeltaText } from './format.js';
import type { ReportModel } from './model.js';

/**
 * Shared, renderer-agnostic chart + tile builders. The SVG they emit is safe
 * for both surfaces: HTML inlines it, and pdfmake wraps the same string in an
 * `{ svg }` node — so the fonts stay Helvetica/Arial and no glyph outside the
 * PDF WinAnsi set (▲/▼/→) is ever drawn. Colour carries direction instead.
 */

const GOOD = '#2e7d32';
const BAD = '#c62828';
const AXIS = '#c9d2dc';
const INK = '#33404d';
const MUTED = '#5a6b7b';

// Telemetry-volume metrics (SIEM events, log/signal counts) dwarf everything
// else and aren't executive QoQ material — the same exclusion the deck uses.
const QOQ_EXCLUDE = /siem|logs|events|signals/i;
// Percent beyond which a swing stops informing the bar length (a tiny prior
// quarter reads as +2000%); capped for ranking + width, but the label still
// shows the honest movement.
const MAG_CAP = 200;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** WinAnsi-safe "vs last" text (mirrors the PDF helper: no → glyph). */
function safeDelta(t: MetricTrend): string {
  return trendDeltaText(t).replace(' → ', ' to ');
}

export interface Mover {
  label: string;
  /** WinAnsi-safe delta text ("+38%", "-12%", "3 to 62"). */
  deltaText: string;
  /** True when the change is good for the client (positive sentiment). */
  good: boolean;
  /** |deltaPct| capped, for ranking + bar scaling. */
  magnitude: number;
}

/**
 * The biggest good/bad quarter-over-quarter movers, largest change first.
 * Only metrics with a clear sentiment are chartable on a diverging axis —
 * neutral movements stay in the section tables.
 */
export function selectMovers(trends: MetricTrend[], max = 6): Mover[] {
  return trends
    .filter(
      (t) =>
        t.current !== null &&
        t.previous !== null &&
        t.deltaPct !== null &&
        t.previous !== 0 &&
        (t.sentiment === 'positive' || t.sentiment === 'negative') &&
        !QOQ_EXCLUDE.test(t.key),
    )
    .map((t) => ({
      label: t.label,
      deltaText: safeDelta(t),
      good: t.sentiment === 'positive',
      magnitude: Math.min(Math.abs(t.deltaPct as number), MAG_CAP),
    }))
    .filter((m) => m.deltaText)
    .sort((a, b) => b.magnitude - a.magnitude)
    .slice(0, max);
}

/**
 * A diverging horizontal bar chart of the biggest QoQ movers: improvements
 * extend right in green, concerns extend left in red, bar length = the size
 * of the change. Returns '' when fewer than two movers exist (not worth a
 * figure). The returned string is a self-contained `<svg>`.
 */
export function moversBarChartSvg(trends: MetricTrend[], opts: { width?: number; max?: number } = {}): string {
  const movers = selectMovers(trends, opts.max ?? 6);
  if (movers.length < 2) return '';
  const width = opts.width ?? 508;
  const rowH = 30;
  const top = 30; // legend band
  const bottom = 6;
  const labelW = 156;
  const valueGutter = 52; // room for the delta text past a bar tip
  const px0 = labelW;
  const px1 = width - 12;
  const cx = (px0 + px1) / 2;
  const half = (px1 - px0) / 2 - valueGutter;
  const maxMag = Math.max(...movers.map((m) => m.magnitude)) || 1;
  const height = top + movers.length * rowH + bottom;

  const rows = movers
    .map((m, i) => {
      const midY = top + i * rowH + rowH / 2;
      const w = Math.max(4, (m.magnitude / maxMag) * half);
      const color = m.good ? GOOD : BAD;
      const barX = m.good ? cx : cx - w;
      const valX = m.good ? cx + w + 6 : cx - w - 6;
      const anchor = m.good ? 'start' : 'end';
      return `<text x="0" y="${(midY + 3.5).toFixed(1)}" font-family="Helvetica, Arial" font-size="10" fill="${INK}">${esc(truncate(m.label, 26))}</text>
<rect x="${barX.toFixed(1)}" y="${(midY - 7).toFixed(1)}" width="${w.toFixed(1)}" height="14" rx="3" fill="${color}"/>
<text x="${valX.toFixed(1)}" y="${(midY + 3.5).toFixed(1)}" text-anchor="${anchor}" font-family="Helvetica, Arial" font-size="9.5" font-weight="bold" fill="${color}">${esc(m.deltaText)}</text>`;
    })
    .join('\n');

  const axis = `<line x1="${cx.toFixed(1)}" y1="${top - 4}" x2="${cx.toFixed(1)}" y2="${top + movers.length * rowH}" stroke="${AXIS}" stroke-width="1"/>`;
  const legend = `<rect x="${width - 236}" y="10" width="10" height="10" rx="2" fill="${GOOD}"/>
<text x="${width - 222}" y="19" font-family="Helvetica, Arial" font-size="9" fill="${MUTED}">Improved</text>
<rect x="${width - 152}" y="10" width="10" height="10" rx="2" fill="${BAD}"/>
<text x="${width - 138}" y="19" font-family="Helvetica, Arial" font-size="9" fill="${MUTED}">Needs attention</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${legend}${axis}${rows}</svg>`;
}

export interface KpiTile {
  value: string;
  label: string;
  color: string;
}

/** Priority order for the executive KPI band (first three metrics available win). */
const KPI_CANDIDATES: Array<{ key: string; label: string }> = [
  { key: 'tickets.total', label: 'Tickets handled' },
  { key: 'email.threats_blocked', label: 'Email threats blocked' },
  { key: 'huntress.blocked_malware', label: 'Malware blocked' },
  { key: 'identity.mfa_coverage_pct', label: 'MFA coverage' },
  { key: 'finance.mrr', label: 'Monthly investment' },
  { key: 'endpoints.managed', label: 'Devices managed' },
];

/**
 * The executive "quarter at a glance" stat tiles — the maturity score plus up
 * to three headline metrics. Shared by the HTML band and the PDF kpiBand so
 * both surfaces tell the same top-line story. Returns [] when there's nothing
 * beyond the score to show; callers gate on `length >= 2`.
 */
export function selectKpiTiles(m: ReportModel): KpiTile[] {
  const tiles: KpiTile[] = [];
  const score = m.scorecard.overall.score;
  tiles.push({
    value: score === null ? '—' : String(Math.round(score)),
    label: 'Security maturity / 100',
    color: ratingColor(m.scorecard.overall.rating),
  });
  const byKey = new Map(m.sections.flatMap((s) => s.rows.map((r) => [r.metric.key, r.metric] as const)));
  for (const c of KPI_CANDIDATES) {
    if (tiles.length >= 4) break;
    const metric = byKey.get(c.key);
    if (metric && metric.value !== null) tiles.push({ value: formatValue(metric), label: c.label, color: m.brand.primary });
  }
  return tiles;
}
