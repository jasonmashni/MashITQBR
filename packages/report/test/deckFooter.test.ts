import { describe, expect, it } from 'vitest';
import { buildReportModel, renderDeck } from '@mashit/report';
import { anpClient, anpQ1Shape, anpQ2, anpQ2Narrative } from './fixtures/anpQ2.js';

/** Text runs of the slide layout a slide uses (where the master footer lives). */
async function layoutTextOfSlide(pptx: Buffer, slide: number): Promise<string> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(pptx);
  const rels = await zip.file(`ppt/slides/_rels/slide${slide}.xml.rels`)!.async('string');
  const layout = rels.match(/Target="\.\.\/slideLayouts\/(slideLayout\d+\.xml)"/)![1]!;
  const xml = await zip.file(`ppt/slideLayouts/${layout}`)!.async('string');
  return [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]!).join(' ');
}

describe('deck footer after the cover', () => {
  it('carries the HIPAA notice and the revision date on a non-cover slide', async () => {
    const model = buildReportModel({ client: { ...anpClient, hipaa: true }, current: anpQ2, previous: anpQ1Shape, narrative: anpQ2Narrative, revisedAt: '2026-08-03T15:00:00Z' });
    const footer = await layoutTextOfSlide(await renderDeck(model), 2);
    expect(footer).toContain('Contains confidential client information (HIPAA).');
    expect(footer).toMatch(/Revised on [A-Z][a-z]+ \d{1,2}, 2026\./);
  });

  it('says Confidential for a client that is not HIPAA covered', async () => {
    const model = buildReportModel({ client: { ...anpClient, hipaa: false }, current: anpQ2, previous: anpQ1Shape, narrative: anpQ2Narrative });
    const footer = await layoutTextOfSlide(await renderDeck(model), 2);
    expect(footer).toContain('Confidential.');
    expect(footer).not.toContain('HIPAA');
  });
});
