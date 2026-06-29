import type { MetricTrend, MetricValue, Rating } from '@mashit/core';

/** Integer with thousands separators (e.g. 12500 -> "12,500"). */
export function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Abbreviate large magnitudes (917000 -> "917K", 12500000 -> "12.5M"). */
export function abbreviate(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return trim(n / 1e9) + 'B';
  if (abs >= 1e6) return trim(n / 1e6) + 'M';
  if (abs >= 1e3) return trim(n / 1e3) + 'K';
  return String(n);
}

function trim(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

export function formatCurrency(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function formatPercent(n: number): string {
  return `${trim(n)}%`;
}

/** Format a metric value using its unit for display. */
export function formatValue(m: Pick<MetricValue, 'value' | 'unit'>): string {
  if (m.value === null) return '—';
  if (typeof m.value === 'boolean') return m.value ? 'Yes' : 'No';
  if (typeof m.value === 'string') return m.value;
  switch (m.unit) {
    case 'USD':
      return formatCurrency(m.value);
    case '%':
      return formatPercent(m.value);
    case 'events':
      return abbreviate(m.value);
    default:
      return formatInt(m.value);
  }
}

/** Arrow + signed delta for a trend, or empty string when not comparable. */
export function formatTrend(t: MetricTrend): string {
  if (t.direction === 'na' || t.previous === null) return '';
  const arrow = t.direction === 'up' ? '▲' : t.direction === 'down' ? '▼' : '↔';
  const pct = t.deltaPct === null ? '' : ` ${t.deltaPct > 0 ? '+' : ''}${trim(t.deltaPct)}%`;
  return `${arrow}${pct}`.trim();
}

/** Brand color for a R/Y/G rating. */
export function ratingColor(rating: Rating): string {
  switch (rating) {
    case 'green':
      return '#2e7d32';
    case 'amber':
      return '#ed9c28';
    case 'red':
      return '#c62828';
    default:
      return '#9e9e9e';
  }
}

/** CSS class suffix for a rating (used by the HTML template). */
export function ratingClass(rating: Rating): string {
  return `rating-${rating}`;
}
