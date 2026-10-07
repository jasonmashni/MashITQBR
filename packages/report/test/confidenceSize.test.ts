import { describe, expect, it } from 'vitest';
import { buildPdfDefinition, buildReportModel } from '@mashit/report';
import { anpClient, anpQ1Shape, anpQ2, anpQ2Narrative } from './fixtures/anpQ2.js';
import { walk } from './pageTools.js';

describe('PDF data confidence', () => {
  it('prints the confidence bullets at 10pt or more', () => {
    const base = buildReportModel({ client: anpClient, current: anpQ2, previous: anpQ1Shape, narrative: anpQ2Narrative });
    const note = 'Backup data covers two of three sites.';
    const def = buildPdfDefinition({ ...base, dataConfidence: [note] });
    const bullets = [...walk(def['content'])].filter((n) => n['text'] === note);
    expect(bullets.length).toBeGreaterThan(0);
    for (const b of bullets) expect(Number(b['fontSize'])).toBeGreaterThanOrEqual(10);
  });
});
