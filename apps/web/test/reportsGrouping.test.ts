import { describe, expect, it } from 'vitest';
import { groupDocumentsByPeriod, sectionTitle, selectionLabel } from '../src/pages/workspace/reportsGrouping.js';

const doc = (id: string, period: string) => ({ id, period, name: `${id}.pdf` });

describe('groupDocumentsByPeriod', () => {
  it('groups by quarter, newest first, keeping row order inside a quarter', () => {
    const docs = [doc('a', '2026-Q2'), doc('b', '2026-Q3'), doc('c', '2025-Q4'), doc('d', '2026-Q3'), doc('e', '2026-Q2')];
    const groups = groupDocumentsByPeriod(docs, '2026-Q3');
    expect(groups.map((g) => g.period)).toEqual(['2026-Q3', '2026-Q2', '2025-Q4']);
    expect(groups[0]!.docs.map((d) => d.id)).toEqual(['b', 'd']);
    expect(groups[1]!.docs.map((d) => d.id)).toEqual(['a', 'e']);
  });

  it('opens only the active quarter', () => {
    const groups = groupDocumentsByPeriod([doc('a', '2026-Q2'), doc('b', '2026-Q3')], '2026-Q2');
    expect(groups.map((g) => [g.period, g.open])).toEqual([
      ['2026-Q3', false],
      ['2026-Q2', true],
    ]);
  });

  it('has no group for a quarter without documents, including the active one', () => {
    const groups = groupDocumentsByPeriod([doc('a', '2026-Q2')], '2026-Q4');
    expect(groups).toEqual([{ period: '2026-Q2', docs: [doc('a', '2026-Q2')], open: false }]);
    expect(groupDocumentsByPeriod([], '2026-Q3')).toEqual([]);
  });

  it('sorts across years', () => {
    const groups = groupDocumentsByPeriod([doc('a', '2025-Q4'), doc('b', '2027-Q1'), doc('c', '2026-Q1')], '2026-Q1');
    expect(groups.map((g) => g.period)).toEqual(['2027-Q1', '2026-Q1', '2025-Q4']);
  });

  it('puts malformed periods after valid ones, in first-seen order', () => {
    const groups = groupDocumentsByPeriod(
      [doc('a', 'legacy'), doc('b', '2025-Q4'), doc('c', ''), doc('d', '2026-Q2'), doc('e', 'legacy'), doc('f', 'zzz')],
      '2026-Q2',
    );
    expect(groups.map((g) => g.period)).toEqual(['2026-Q2', '2025-Q4', 'legacy', '', 'zzz']);
    expect(groups.find((g) => g.period === 'legacy')!.docs.map((d) => d.id)).toEqual(['a', 'e']);
  });
});

describe('sectionTitle', () => {
  it('counts reports', () => {
    expect(sectionTitle('2026-Q3', 4)).toBe('2026-Q3 (4 reports)');
    expect(sectionTitle('2026-Q2', 1)).toBe('2026-Q2 (1 report)');
  });
});

describe('selectionLabel', () => {
  it('names the sections only when the selection spans more than one', () => {
    expect(selectionLabel(1, 1)).toBe('1 selected');
    expect(selectionLabel(3, 1)).toBe('3 selected');
    expect(selectionLabel(3, 2)).toBe('3 selected across 2 sections');
  });
});
