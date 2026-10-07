import type { NarrativeOutput } from '@mashit/narrative';

/** A v4 narrative inside every limit and free of figures; spread overrides on top. */
export function v4Narrative(overrides: Partial<NarrativeOutput> = {}): NarrativeOutput {
  return {
    headline: 'A steady quarter',
    lede: 'Support ran smoothly and security held.',
    did: ['Handled support requests.', 'Kept devices patched.', 'Watched for threats.'],
    saw: ['Demand was steady.', 'No incidents spread.', 'Backups ran.'],
    decisions: [],
    plan: { now: [], next: [], later: [] },
    protection: [
      { question: 'get_in', inPlace: 'MFA on every user.', thisQuarter: 'Phishing stopped.' },
      { question: 'know', inPlace: 'A security team watches around the clock.', thisQuarter: 'No incidents.' },
      { question: 'recover', inPlace: 'Daily cloud backup.', thisQuarter: 'Backups ran.' },
      { question: 'keep_up', inPlace: 'Monthly patching.', thisQuarter: 'Updates installed.' },
      { question: 'run_well', inPlace: 'Quarterly reviews.', thisQuarter: 'Review held.' },
    ],
    figures_referenced: [],
    ...overrides,
  };
}
