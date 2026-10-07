import { describe, expect, it } from 'vitest';
import { counterState, LIMITS, styleHits } from '../src/pages/workspace/narrativeLimits.js';

describe('narrative editor counters', () => {
  it('counts words and flags a field over its limit', () => {
    expect(counterState('one two three', 2)).toEqual({ count: 3, over: true });
    expect(counterState('  one   two ', 2)).toEqual({ count: 2, over: false });
    expect(counterState('', 12)).toEqual({ count: 0, over: false });
  });

  it('mirrors the narrative contract limits', () => {
    expect(LIMITS).toEqual({ headlineWords: 12, ledeWords: 60, bulletWords: 18, didMin: 3, didMax: 4, decisionsMax: 3, planPerColumn: 3, protectionWords: 40 });
  });

  it('lists dashes and machine-sounding phrases', () => {
    expect(styleHits('A robust quarter — we leverage tools')).toEqual(['em dash', 'robust', 'leverage']);
    expect(styleHits('A steady quarter.')).toEqual([]);
  });
});
