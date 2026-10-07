import { describe, it, expect } from 'vitest';
import { assertNarrativeShape, limitIssues, NARRATIVE_JSON_SCHEMA, NARRATIVE_LIMITS, SYSTEM_PROMPT, verifyNarrative, wordCount, type NarrativeOutput } from '@mashit/narrative';

const v4base: NarrativeOutput = {
  headline: 'Fewer tickets, faster response, backups steady',
  lede: 'Support demand fell and response held. One item needs your decision.',
  did: ['Closed 62 tickets this quarter.', 'Installed 3,990 updates.', 'Blocked 18 phishing emails.'],
  saw: ['Five missed deadlines on access requests.', 'Updates waiting on production PCs.', 'One lab PC is not backing up.'],
  decisions: [{ ask: 'Approve replacing devices past warranty', why: 'They are out of support', by: 'Nov 15' }],
  plan: {
    now: [{ action: 'Fix the lab PC backup', owner: 'Mash IT' }],
    next: [{ action: 'Quote the device refresh', owner: 'Mash IT', decision: true }],
    later: [],
  },
  protection: [
    { question: 'get_in', inPlace: 'MFA on every user.', thisQuarter: 'Phishing stopped.' },
    { question: 'know', inPlace: 'A security team watches around the clock.', thisQuarter: 'No incidents.' },
    { question: 'recover', inPlace: 'Daily cloud backup.', thisQuarter: 'Backups ran.' },
    { question: 'keep_up', inPlace: 'Monthly patching.', thisQuarter: 'Updates installed.' },
    { question: 'run_well', inPlace: 'Quarterly reviews.', thisQuarter: 'Review held.' },
  ],
  figures_referenced: [],
};
const allowed = [62, 3990, 18];

describe('narrative limits', () => {
  it('reports every limit breach by field', () => {
    const out = { ...v4base, headline: 'one two three four five six seven eight nine ten eleven twelve thirteen', did: ['a', 'b'] };
    expect(limitIssues(out)).toEqual(['headline: 13 words (limit 12)', 'did: 2 items (3 to 4)']);
    expect(verifyNarrative(out, allowed).ok).toBe(false);
  });

  it('passes a compliant v4 output', () => {
    expect(limitIssues(v4base)).toEqual([]);
    expect(verifyNarrative(v4base, allowed).ok).toBe(true);
  });

  it('counts words on whitespace', () => {
    expect(wordCount('  one two\tthree\nfour ')).toBe(4);
    expect(wordCount('')).toBe(0);
    expect(NARRATIVE_LIMITS.headlineWords).toBe(12);
  });

  it('checks lede, bullets, decisions, plan columns and protection', () => {
    const long = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
    const out: NarrativeOutput = {
      ...v4base,
      lede: long(61),
      saw: [long(19), 'b', 'c', 'd', 'e'],
      decisions: [{ ask: 'a' }, { ask: 'b' }, { ask: 'c' }, { ask: 'd' }],
      plan: { now: [{ action: 'a', owner: 'x' }, { action: 'b', owner: 'x' }, { action: 'c', owner: 'x' }, { action: 'd', owner: 'x' }], next: [], later: [] },
      protection: [
        { question: 'know', inPlace: long(41), thisQuarter: 'x' },
        { question: 'get_in', inPlace: 'x', thisQuarter: 'x' },
        { question: 'recover', inPlace: 'x', thisQuarter: 'x' },
        { question: 'keep_up', inPlace: 'x', thisQuarter: 'x' },
      ],
    };
    expect(limitIssues(out)).toEqual([
      'lede: 61 words (limit 60)',
      'saw: 5 items (3 to 4)',
      'saw[0]: 19 words (limit 18)',
      'decisions: 4 items (limit 3)',
      'plan.now: 4 items (limit 3)',
      'protection: 4 items (exactly 5)',
      'protection[0]: know where get_in belongs',
      'protection[1]: get_in where know belongs',
      'protection.know.inPlace: 41 words (limit 40)',
    ]);
    const r = verifyNarrative(out, allowed);
    const limits = r.failures.find((f) => f.label === 'limits');
    expect(limits?.unmatched).toEqual(limitIssues(out));
  });
});

describe('v4 contract', () => {
  it('the JSON schema requires only the v4 fields', () => {
    expect([...NARRATIVE_JSON_SCHEMA.required].sort()).toEqual(
      ['decisions', 'did', 'figures_referenced', 'headline', 'lede', 'plan', 'protection', 'saw', 'section_summaries'].sort(),
    );
    const props = NARRATIVE_JSON_SCHEMA.properties as Record<string, unknown>;
    expect(props['summary_paragraphs']).toBeUndefined();
    const protection = props['protection'] as { items: { properties: { question: { enum: string[] } }; additionalProperties: boolean } };
    expect(protection.items.properties.question.enum).toEqual(['get_in', 'know', 'recover', 'keep_up', 'run_well']);
    expect(protection.items.additionalProperties).toBe(false);
    const plan = props['plan'] as { required: string[]; additionalProperties: boolean };
    expect(plan.required).toEqual(['now', 'next', 'later']);
    expect(plan.additionalProperties).toBe(false);
  });

  it('the system prompt uses no dashes and describes the output shape', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/[—–]/);
    expect(SYSTEM_PROMPT).toContain('Output shape: headline (under 12 words');
  });

  it('assertNarrativeShape checks every v4 field', () => {
    expect(() => assertNarrativeShape(v4base)).not.toThrow();
    const { did: _did, ...noDid } = v4base;
    expect(() => assertNarrativeShape(noDid)).toThrow(/did/);
    expect(() => assertNarrativeShape({ ...v4base, plan: { now: [], next: [] } })).toThrow(/plan/);
    expect(() => assertNarrativeShape({ ...v4base, protection: [{ question: 'get_in', inPlace: 1, thisQuarter: '' }] })).toThrow(/protection/);
    expect(() => assertNarrativeShape({ ...v4base, decisions: [{ why: 'x' }] })).toThrow(/decisions/);
  });
});
