import type {
  MetricSnapshot,
  MetricTrend,
  MetricValue,
  TrendDirection,
  TrendSentiment,
} from './types.js';

/** Coerce a metric value to a finite number, or null if it isn't numeric. */
export function asNumber(value: MetricValue['value']): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/** Index a snapshot's metrics by key for O(1) lookup. */
export function indexMetrics(snapshot: MetricSnapshot): Map<string, MetricValue> {
  const map = new Map<string, MetricValue>();
  for (const m of snapshot.metrics) map.set(m.key, m);
  return map;
}

/** Lookup helper used by the scorecard and trend engine. */
export interface MetricLookup {
  has(key: string): boolean;
  num(key: string): number | null;
  get(key: string): MetricValue | undefined;
}

export function lookup(snapshot: MetricSnapshot): MetricLookup {
  const map = indexMetrics(snapshot);
  return {
    has: (key) => map.has(key),
    num: (key) => {
      const v = map.get(key);
      return v ? asNumber(v.value) : null;
    },
    get: (key) => map.get(key),
  };
}

function direction(current: number, previous: number): TrendDirection {
  if (current > previous) return 'up';
  if (current < previous) return 'down';
  return 'flat';
}

function sentiment(dir: TrendDirection, higherIsBetter: boolean | undefined): TrendSentiment {
  if (dir === 'flat') return 'neutral';
  if (dir === 'na') return 'na';
  if (higherIsBetter === undefined) return 'neutral';
  const improved = (dir === 'up' && higherIsBetter) || (dir === 'down' && !higherIsBetter);
  return improved ? 'positive' : 'negative';
}

/**
 * Compute quarter-over-quarter trends for every numeric metric in the current
 * snapshot. This is the single source of "pre-computed numbers" handed to the
 * AI narrative layer — the model never does arithmetic itself.
 */
export function computeTrends(
  current: MetricSnapshot,
  previous?: MetricSnapshot,
): MetricTrend[] {
  const prevMap = previous ? indexMetrics(previous) : new Map<string, MetricValue>();
  const trends: MetricTrend[] = [];

  for (const m of current.metrics) {
    const cur = asNumber(m.value);
    if (cur === null) continue; // only numeric metrics get trends

    const prevMetric = prevMap.get(m.key);
    const prev = prevMetric ? asNumber(prevMetric.value) : null;

    let deltaAbs: number | null = null;
    let deltaPct: number | null = null;
    let dir: TrendDirection = 'na';

    if (prev !== null) {
      deltaAbs = round(cur - prev);
      deltaPct = prev !== 0 ? round(((cur - prev) / Math.abs(prev)) * 100) : null;
      dir = direction(cur, prev);
    }

    trends.push({
      key: m.key,
      label: m.label,
      unit: m.unit,
      category: m.category,
      current: cur,
      previous: prev,
      deltaAbs,
      deltaPct,
      direction: dir,
      sentiment: sentiment(dir, m.higherIsBetter),
    });
  }

  return trends;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Build a quick key->trend index for templating. */
export function indexTrends(trends: MetricTrend[]): Map<string, MetricTrend> {
  const map = new Map<string, MetricTrend>();
  for (const t of trends) map.set(t.key, t);
  return map;
}
