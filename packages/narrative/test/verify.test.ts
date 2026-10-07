import { describe, it, expect } from 'vitest';
import { buildAllowedQuotes, verifyFigures, verifyNarrative, type NarrativeInput, type NarrativeOutput } from '@mashit/narrative';
import { v4 } from './v4.js';

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
    const out: NarrativeOutput = v4({
      headline: 'Uptime hit 99.97%',
      lede: 'We closed 141 tickets.',
      did: ['audited 88,888 devices', 'b', 'c'],
      figures_referenced: [{ label: 'tickets', value: '141' }],
    });
    const r = verifyNarrative(out, [141]);
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.label)).toEqual(['headline', 'did[0]']);
  });

  it('labels every prose field, including section summaries', () => {
    const out: NarrativeOutput = v4({
      headline: 'h',
      lede: 'l',
      did: ['a', 'b', 'c'],
      saw: ['d', 'e', '7 laptops'],
      decisions: [{ ask: 'Approve', why: 'Because', by: 'Nov 15' }],
      plan: { now: [{ action: 'Fix', owner: 'Mash IT' }], next: [], later: [{ action: 'Plan', owner: 'ANP', decision: true }] },
      section_summaries: [{ category: 'security', summary: '3 incidents' }],
      recommendations: ['legacy'],
    });
    const r = verifyNarrative(out, []);
    expect(r.checks.map((c) => c.label)).toEqual([
      'headline',
      'lede',
      'did[0]',
      'did[1]',
      'did[2]',
      'saw[0]',
      'saw[1]',
      'saw[2]',
      'decisions[0].ask',
      'decisions[0].why',
      'plan.now[0].action',
      'plan.now[0].owner',
      'plan.later[0].action',
      'plan.later[0].owner',
      'protection.get_in.inPlace',
      'protection.get_in.thisQuarter',
      'protection.know.inPlace',
      'protection.know.thisQuarter',
      'protection.recover.inPlace',
      'protection.recover.thisQuarter',
      'protection.keep_up.inPlace',
      'protection.keep_up.thisQuarter',
      'protection.run_well.inPlace',
      'protection.run_well.thisQuarter',
      'recommendations[0]',
      'section_summaries.security',
    ]);
    expect(r.failures.map((f) => f.label)).toEqual(['saw[2]', 'section_summaries.security']);
  });

  it('ignores dates and version tokens in prose', () => {
    const out: NarrativeOutput = v4({
      headline: 'Aligned to CIS Controls v8 and NIST CSF 2.0 for Q1 2026',
      lede: 'As of 2026-03-31, M365 is monitored 24/7.',
    });
    expect(verifyNarrative(out, []).ok).toBe(true);
  });

  it('catches a number that appears only in a protection field', () => {
    const out: NarrativeOutput = v4({
      lede: 'We closed 141 tickets.',
      protection: v4().protection.map((p) => (p.question === 'know' ? { ...p, thisQuarter: 'Response times improved by 37%.' } : p)),
      figures_referenced: [{ label: 'tickets', value: '141' }],
    });
    const r = verifyNarrative(out, [141]);
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.label)).toEqual(['protection.know.thisQuarter']);
    expect(r.failures[0]!.unmatched).toEqual([37]);
  });
});

describe('verifyNarrative and quoted spans', () => {
  const prose = (text: string): NarrativeOutput => v4({ lede: text });

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


describe('style lint', () => {
  const base: NarrativeOutput = v4();
  const allowed: number[] = [];
  it('flags em dashes and model phrases without failing verification', () => {
    const out = { ...base, headline: 'A quarter that reinforces trust — again', saw: ['Leverage the landscape', 'b', 'c'] };
    const r = verifyNarrative(out, allowed);
    expect(r.ok).toBe(true);
    expect(r.style).toEqual(['headline: em dash', 'headline: reinforces', 'saw: leverage', 'saw: landscape']);
  });
  it('scans nested plan items and protection prose', () => {
    const out = v4({
      plan: { now: [{ action: 'Navigate the move', owner: 'Mash IT' }], next: [], later: [] },
      protection: v4().protection.map((p, i) => (i === 0 ? { ...p, inPlace: 'A robust wall – mostly' } : p)),
    });
    expect(verifyNarrative(out, allowed).style).toEqual(['plan: navigate', 'protection: em dash', 'protection: robust']);
  });
  it('scans section summaries and reports nothing for clean prose', () => {
    expect(verifyNarrative({ ...base, section_summaries: [{ category: 'security', summary: 'A robust year' }] }, allowed).style).toEqual([
      'section_summaries: robust',
    ]);
    expect(verifyNarrative(base, allowed).style).toEqual([]);
  });
});
