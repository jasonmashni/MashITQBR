import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { appendPdfAttachments } from '../src/pdfMerge.js';

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage();
  return Buffer.from(await doc.save());
}

describe('appendPdfAttachments', () => {
  it('appends every attached PDF to the back of the main report', async () => {
    const main = await makePdf(3);
    const huntress = await makePdf(2);
    const checkpoint = await makePdf(4);
    const merged = await appendPdfAttachments(main, [huntress, checkpoint]);
    const doc = await PDFDocument.load(merged);
    expect(doc.getPageCount()).toBe(9);
  });

  it('skips unreadable attachments without breaking the report', async () => {
    const main = await makePdf(2);
    const merged = await appendPdfAttachments(main, [Buffer.from('not a pdf at all')]);
    const doc = await PDFDocument.load(merged);
    expect(doc.getPageCount()).toBe(2);
  });

  it('returns the main PDF untouched when there is nothing to append', async () => {
    const main = await makePdf(1);
    expect(await appendPdfAttachments(main, [])).toBe(main);
  });
});
