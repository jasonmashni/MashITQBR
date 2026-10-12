import type { MetricTrend } from '@mashit/core';
import { formatPercent, formatValue, ratingColor, ratingWord, SEMANTIC, trendDeltaText } from './format.js';
import type { ReportModel } from './model.js';

/**
 * Shared, renderer-agnostic chart + tile builders. The SVG they emit is safe
 * for both surfaces: HTML inlines it, and pdfmake wraps the same string in an
 * `{ svg }` node — so the fonts stay Helvetica/Arial and no glyph outside the
 * PDF WinAnsi set (▲/▼/→) is ever drawn. Colour carries direction instead.
 */

const GOOD = SEMANTIC.good;
const BAD = SEMANTIC.act;
const AXIS = SEMANTIC.hairline;
const INK = SEMANTIC.text;
const MUTED = SEMANTIC.muted;

// Telemetry-volume metrics (SIEM events, log/signal counts) dwarf everything
// else and aren't executive QoQ material — the same exclusion the deck uses.
const QOQ_EXCLUDE = /siem|logs|events|signals/i;
/**
 * Percent beyond which a swing stops informing the bar length (a tiny prior
 * quarter reads as +2000%); capped for ranking + width, but the label still
 * shows the honest movement. Captions must say the bar is capped.
 */
export const MOVER_MAGNITUDE_CAP = 200;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** WinAnsi-safe "vs last" text (mirrors the PDF helper: no → glyph). */
export function safeDelta(t: MetricTrend): string {
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
  /** True when the bar length was capped and understates the real swing. */
  capped: boolean;
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
      magnitude: Math.min(Math.abs(t.deltaPct as number), MOVER_MAGNITUDE_CAP),
      capped: Math.abs(t.deltaPct as number) > MOVER_MAGNITUDE_CAP,
    }))
    .filter((m) => m.deltaText)
    .sort((a, b) => b.magnitude - a.magnitude)
    .slice(0, max);
}

/** Caption for the movers figure; names the cap only when a bar actually hit it. */
export function moversCaption(trends: MetricTrend[], max = 6): string {
  const movers = selectMovers(trends, max);
  const capped = movers.some((m) => m.capped);
  return `Improvements extend right; areas needing attention extend left. Bar length shows the size of the change${
    capped ? `, capped at ${MOVER_MAGNITUDE_CAP}% so one extreme swing does not flatten the rest; the label carries the real movement` : ''
  }.`;
}

/**
 * A diverging horizontal bar chart of the biggest QoQ movers: improvements
 * extend right in teal, concerns extend left in red, bar length = the size
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
<rect x="${barX.toFixed(1)}" y="${(midY - 7).toFixed(1)}" width="${w.toFixed(1)}" height="14" rx="2" fill="${color}"/>
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
  /** Second line under the value: a WinAnsi-safe trend ("up from 47", "0 to 3") or a confidence note. */
  note?: string;
  /** Sentiment of the note, for colour; undefined renders in muted ink. */
  noteTone?: 'good' | 'bad' | 'neutral';
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

/** Trend note for a tile: "up from 47" / "down from 60" / "0 to 3"; blank with no prior quarter. */
function tileNote(t: MetricTrend | undefined, unit: string | undefined): Pick<KpiTile, 'note' | 'noteTone'> {
  if (!t || t.previous === null || t.current === null || t.direction === 'na') return {};
  if (t.direction === 'flat') return { note: 'unchanged from last quarter', noteTone: 'neutral' };
  const tone: KpiTile['noteTone'] = t.sentiment === 'positive' ? 'good' : t.sentiment === 'negative' ? 'bad' : 'neutral';
  if (t.previous === 0) return { note: safeDelta(t), noteTone: tone };
  const prev = formatValue({ value: t.previous, unit });
  return { note: `${t.direction === 'up' ? 'up' : 'down'} from ${prev}`, noteTone: tone };
}

/**
 * The executive "quarter at a glance" stat tiles — the maturity score plus up
 * to three headline metrics. Shared by the HTML band and the PDF kpiBand so
 * both surfaces tell the same top-line story. Returns [] when there's nothing
 * beyond the score to show; callers gate on `length >= 2`.
 *
 * The score tile is honest about confidence: with low coverage it says
 * "Not scored" instead of a number; with medium coverage it is marked
 * provisional and carries the coverage figure.
 */
export function selectKpiTiles(m: ReportModel): KpiTile[] {
  const tiles: KpiTile[] = [];
  const { score, rating, coverage, confidence } = m.scorecard.overall;
  const coverageText = `${formatPercent(Math.round(coverage * 100))} of controls measured`;
  if (score === null || confidence === 'low') {
    tiles.push({ value: 'Not scored', label: 'Security maturity', color: SEMANTIC.unknown, note: coverageText, noteTone: 'neutral' });
  } else {
    tiles.push({
      value: String(Math.round(score)),
      label: 'Security maturity, out of 100',
      color: ratingColor(rating),
      note: confidence === 'medium' ? `${ratingWord(rating)}, provisional: ${coverageText}` : `${ratingWord(rating)}, ${coverageText}`,
      noteTone: 'neutral',
    });
  }
  const byKey = new Map(m.sections.flatMap((s) => s.rows.map((r) => [r.metric.key, r] as const)));
  for (const c of KPI_CANDIDATES) {
    if (tiles.length >= 4) break;
    const row = byKey.get(c.key);
    if (row && row.metric.value !== null) {
      tiles.push({ value: formatValue(row.metric), label: c.label, color: m.brand.primary, ...tileNote(row.trend, row.metric.unit) });
    }
  }
  return tiles;
}

/**
 * "Where it went": one horizontal bar per invoice category, largest first.
 * Recurring lines are solid brand; project and support work is a lighter
 * tint so the split reads without a legend. Returns '' with no lines.
 */
export function investmentBarsSvg(
  breakdown: Array<{ label: string; amount: number; recurring: boolean }>,
  width = 508,
  colors: { recurring: string; variable: string } = { recurring: '#004aad', variable: '#8fb3e6' },
): string {
  const rows = breakdown.filter((b) => b.amount > 0).slice(0, 8);
  if (!rows.length) return '';
  const rowH = 24;
  const labelW = 190;
  const valueW = 72;
  const barMax = width - labelW - valueW - 8;
  const max = Math.max(...rows.map((r) => r.amount));
  const height = rows.length * rowH + 4;
  const body = rows
    .map((r, i) => {
      const y = i * rowH + 4;
      const w = Math.max(3, (r.amount / max) * barMax);
      const value = r.amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
      return `<text x="0" y="${y + 12}" font-family="Helvetica, Arial" font-size="10" fill="${INK}">${esc(truncate(r.label, 34))}</text>
<rect x="${labelW}" y="${y + 2}" width="${w.toFixed(1)}" height="13" rx="2" fill="${r.recurring ? colors.recurring : colors.variable}"/>
<text x="${width}" y="${y + 12}" text-anchor="end" font-family="Helvetica, Arial" font-size="10" font-weight="bold" fill="${INK}">${esc(value)}</text>`;
    })
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

/**
 * Plan versus actual: a track filled to `pct` of the plan, with a tick at the
 * share of the fiscal year elapsed when given. Clamped to 0..100 for the
 * bar; the caller prints the real figures beside it.
 */
export function planMeterSvg(pct: number, width = 508, opts: { elapsedPct?: number; color?: string } = {}): string {
  const h = 22;
  const track = 12;
  const fill = Math.max(0, Math.min(100, pct));
  const color = opts.color ?? (pct > 110 ? BAD : GOOD);
  const tick =
    opts.elapsedPct === undefined
      ? ''
      : `<rect x="${((Math.max(0, Math.min(100, opts.elapsedPct)) / 100) * width - 1).toFixed(1)}" y="0" width="2" height="${h}" fill="${INK}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">
<rect x="0" y="${(h - track) / 2}" width="${width}" height="${track}" rx="6" fill="${SEMANTIC.unknownBg}"/>
${fill > 0 ? `<rect x="0" y="${(h - track) / 2}" width="${((fill / 100) * width).toFixed(1)}" height="${track}" rx="6" fill="${color}"/>` : ''}
${tick}
</svg>`;
}
