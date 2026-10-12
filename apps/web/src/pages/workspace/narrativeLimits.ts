/**
 * Live counters for the narrative editor. The limits mirror NARRATIVE_LIMITS
 * in packages/narrative/src/limits.ts and the phrases mirror STYLE_BANNED in
 * verify.ts (the web build does not import the narrative package); the server
 * still verifies on every build, so a drift here only affects the hints.
 */
export const LIMITS = {
  headlineWords: 12,
  ledeWords: 60,
  bulletWords: 18,
  didMin: 3,
  didMax: 4,
  decisionsMax: 3,
  planPerColumn: 3,
  protectionWords: 40,
} as const;

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Word count against a limit: `over` turns the counter red. */
export function counterState(text: string, limit: number): { count: number; over: boolean } {
  const count = wordCount(text);
  return { count, over: count > limit };
}

const BANNED = [
  'reinforces',
  'underscores',
  'leaves room to climb',
  'worth a brief review',
  'robust',
  'leverage',
  'landscape',
  'holistic',
  'seamless',
  'journey',
  'navigate',
  'foster',
  'a testament to',
  'it is worth noting',
  "it's worth noting",
  "in today's",
];

/** Dashes and machine-sounding phrases in a piece of prose, in a stable order. */
export function styleHits(text: string): string[] {
  const hits: string[] = [];
  if (/[—–]/.test(text)) hits.push('em dash');
  const lower = text.toLowerCase();
  for (const phrase of BANNED) if (lower.includes(phrase)) hits.push(phrase);
  return hits;
}

/** One line per item; blank lines dropped. */
export function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}
