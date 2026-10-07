/** Helpers for walking a pdfmake definition and a rendered deck in tests. */

export type PdfNode = Record<string, unknown>;

const parents = new WeakMap<object, object | undefined>();

/** Every object node in a pdfmake content tree, depth first, remembering parents. */
export function* walk(node: unknown, parent?: object): Generator<PdfNode> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child, parent);
    return;
  }
  if (node && typeof node === 'object') {
    parents.set(node, parent);
    yield node as PdfNode;
    for (const value of Object.values(node)) if (value && typeof value === 'object') yield* walk(value, node);
  }
}

/** True when the node or one of its ancestors is marked unbreakable. */
export function parentIsUnbreakable(node: object): boolean {
  let current: object | undefined = node;
  while (current) {
    if ((current as PdfNode)['unbreakable'] === true) return true;
    current = parents.get(current);
  }
  return false;
}

/** Plain text of a pdfmake text value (string, node or array of runs). */
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (value && typeof value === 'object') return textOf((value as PdfNode)['text']);
  return '';
}

/** Text of every node styled h1, in document order: the page titles. */
export function h1Titles(def: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const node of walk(def['content'])) if (node['style'] === 'h1') out.push(textOf(node['text']));
  return out;
}

/** Text runs of every slide in a rendered deck, in slide order. */
export async function slideTexts(pptx: Buffer): Promise<string[][]> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(pptx);
  const names = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
  const out: string[][] = [];
  for (const name of names) {
    const xml = await zip.file(name)!.async('string');
    out.push([...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]!.replace(/&amp;/g, '&').trim()).filter(Boolean));
  }
  return out;
}
