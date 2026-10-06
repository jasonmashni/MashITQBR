import { describe, it, expect } from 'vitest';
import { buildAllowedQuotes, verifyFigures, verifyNarrative, type NarrativeInput, type NarrativeOutput } from '@mashit/narrative';

describe('verifyFigures', () => {
  const allowed = [141, 47, 94, 200];

  it('passes when every cited number is traceable', () => {
    const result = verifyFigures(
      [{ label: 'ticket volume', value: '141 (up from 47, +200%)' }],
      allowed,
    );
    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('flags a fabricated figure', () => {
    const result = verifyFigures([{ label: 'uptime', value: '99.9%' }], allowed);
    expect(result.ok).toBe(false);
    expect(result.failures[0]!.unmatched).toContain(99.9);
  });

  it('treats non-numeric values as verified', () => {
    const result = verifyFigures([{ label: 'posture', value: 'strong' }], allowed);
    expect(result.ok).toBe(true);
  });

  it('flags only the bad number in a mixed value', () => {
    const result = verifyFigures([{ label: 'mixed', value: '141 tickets and 7 outages' }], allowed);
    expect(result.ok).toBe(false);
    expect(result.failures[0]!.unmatched).toEqual([7]);
  });
});

describe('verifyNarrative', () => {
  it('catches a number that only appears in prose', () => {
    const out: NarrativeOutput = {
      headline: 'Uptime hit 99.97%',
      summary_paragraphs: ['We closed 141 tickets.'],
      highlights: ['audited 88,888 devices'],
      recommendations: [],
      figures_referenced: [{ label: 'tickets', value: '141' }],
    };
    const r = verifyNarrative(out, [141]);
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.label)).toEqual(['headline', 'highlights[0]']);
  });

  it('labels every prose field, including section summaries', () => {
    const out: NarrativeOutput = {
      headline: 'h',
      summary_paragraphs: ['a', 'b'],
      highlights: ['c', 'd', 'e'],
      recommendations: ['f', '7 laptops'],
      section_summaries: [{ category: 'security', summary: '3 incidents' }],
      figures_referenced: [],
    };
    const r = verifyNarrative(out, []);
    expect(r.checks.map((c) => c.label)).toEqual([
      'headline',
      'summary_paragraphs[0]',
      'summary_paragraphs[1]',
      'highlights[0]',
      'highlights[1]',
      'highlights[2]',
      'recommendations[0]',
      'recommendations[1]',
      'section_summaries.security',
    ]);
    expect(r.failures.map((f) => f.label)).toEqual(['recommendations[1]', 'section_summaries.security']);
  });

  it('ignores dates and version tokens in prose', () => {
    const out: NarrativeOutput = {
      headline: 'Aligned to CIS Controls v8 and NIST CSF 2.0 for Q1 2026',
      summary_paragraphs: ['As of 2026-03-31, M365 is monitored 24/7.'],
      highlights: [],
      recommendations: [],
      figures_referenced: [],
    };
    expect(verifyNarrative(out, []).ok).toBe(true);
  });

  it('catches a number that appears only in summary_paragraphs', () => {
    const out: NarrativeOutput = {
      headline: 'A steady quarter',
      summary_paragraphs: ['We closed 141 tickets.', 'Response times improved by 37%.'],
      highlights: [],
      recommendations: [],
      figures_referenced: [{ label: 'tickets', value: '141' }],
    };
    const r = verifyNarrative(out, [141]);
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.label)).toEqual(['summary_paragraphs[1]']);
    expect(r.failures[0]!.unmatched).toEqual([37]);
  });
});

describe('verifyNarrative and quoted spans', () => {
  const prose = (text: string): NarrativeOutput => ({
    headline: 'A steady quarter',
    summary_paragraphs: [text],
    highlights: [],
    recommendations: [],
    figures_referenced: [],
  });

  it('flags an unknown number inside curly quotes', () => {
    const r = verifyNarrative(prose('Our team saved you “$48,000” this year.'), []);
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.unmatched).toEqual([48000]);
  });

  it('still flags it when other quotes are allowed', () => {
    const r = verifyNarrative(prose('Our team saved you “$48,000” this year.'), [], { allowedQuotes: ['Windows 11 upgrade'] });
    expect(r.ok).toBe(false);
  });

  it('ignores a quoted real ticket subject from the input', () => {
    const input = {
      ticketSamples: { incidents: ['Windows 11 upgrade for exam room 3'], changes: [], slaBreaches: [] },
      ticketInsights: [],
    } as unknown as NarrativeInput;
    const quotes = buildAllowedQuotes(input);
    const r = verifyNarrative(prose('Tickets such as “windows 11 upgrade for exam room 3 ” recurred.'), [], { allowedQuotes: quotes });
    expect(r.ok).toBe(true);
  });

  it('collects quoted tokens from insight titles and details', () => {
    const input = {
      ticketInsights: [
        { title: 'Recurring theme: “VPN” appears in 3 tickets', detail: '3 tickets reference “vpn” (e.g. “VPN drop P73”, “VPN slow”).', severity: 'medium' },
      ],
    } as unknown as NarrativeInput;
    expect(buildAllowedQuotes(input)).toEqual(expect.arrayContaining(['VPN', 'vpn', 'VPN drop P73', 'VPN slow']));
  });
});
