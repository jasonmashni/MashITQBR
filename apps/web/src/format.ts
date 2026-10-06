/**
 * One number vocabulary for the admin app. Whole dollars carry no cents,
 * fractional amounts keep two; counts group thousands; percents keep one
 * decimal at most. Matches packages/report so a figure reads the same on the
 * Data tab and in the client's report.
 */

export function money(n: number): string {
  const whole = Number.isInteger(n);
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
}

/** Compact currency for pipeline sums ($12K, $1.2M) so a column stays narrow. */
export function compactMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
}

export function count(n: number): string {
  return Math.abs(n) >= 1e6 ? abbreviate(n) : Number.isInteger(n) ? n.toLocaleString('en-US') : (Math.round(n * 10) / 10).toString();
}

export function abbreviate(n: number): string {
  const abs = Math.abs(n);
  const trim = (x: number) => (Math.round(x * 10) / 10).toString();
  if (abs >= 1e9) return trim(n / 1e9) + 'B';
  if (abs >= 1e6) return trim(n / 1e6) + 'M';
  if (abs >= 1e3) return trim(n / 1e3) + 'K';
  return String(n);
}

export function percent(n: number): string {
  return `${Math.round(n * 10) / 10}%`;
}

/** A metric value with its unit, the way the report prints it. */
export function metricValue(m: { value: number | string | boolean | null; unit?: string }): string {
  if (m.value === null) return '—';
  if (typeof m.value === 'boolean') return m.value ? 'Yes' : 'No';
  if (typeof m.value === 'string') return m.value;
  switch (m.unit) {
    case 'USD':
      return money(m.value);
    case '%':
      return percent(m.value);
    case 'events':
      return abbreviate(m.value);
    default: {
      const num = count(m.value);
      return m.unit && m.unit !== 'count' ? `${num} ${m.unit}` : num;
    }
  }
}

/** "Mon, Oct 6 at 2:00 PM" */
export function when(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
