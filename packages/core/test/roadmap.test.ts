import { describe, it, expect } from 'vitest';
import { roadmapValue, type RoadmapItem } from '@mashit/core';

const item = (over: Partial<RoadmapItem>): RoadmapItem => ({ status: 'idea', ...over });

describe('roadmapValue', () => {
  it('annualizes recurring and adds one-time across open items', () => {
    const s = roadmapValue([
      item({ status: 'idea', value: 12000, valueKind: 'one_time' }),
      item({ status: 'approved', value: 500, valueKind: 'recurring' }), // 6000/yr
      item({ status: 'pushed', value: 250, valueKind: 'recurring' }), // 3000/yr — pushed is still open
    ]);
    expect(s.oneTime).toBe(12000);
    expect(s.recurringMonthly).toBe(750);
    expect(s.annualValue).toBe(12000 + 750 * 12);
    expect(s.count).toBe(3);
  });

  it('excludes closed items and value-less cards', () => {
    const s = roadmapValue([
      item({ status: 'closed', value: 99000, valueKind: 'one_time' }), // won/lost — not pipeline
      item({ status: 'idea' }), // no value
      item({ status: 'discussing', value: 4000, valueKind: 'one_time' }),
    ]);
    expect(s.annualValue).toBe(4000);
    expect(s.count).toBe(1);
  });

  it('treats a missing valueKind as one-time and ignores non-positive values', () => {
    const s = roadmapValue([
      item({ status: 'idea', value: 8000 }),
      item({ status: 'idea', value: 0 }),
      item({ status: 'idea', value: -100 }),
    ]);
    expect(s.oneTime).toBe(8000);
    expect(s.annualValue).toBe(8000);
    expect(s.count).toBe(1);
  });

  it('is zero for an empty board', () => {
    expect(roadmapValue([])).toEqual({ annualValue: 0, recurringMonthly: 0, oneTime: 0, count: 0 });
  });
});
