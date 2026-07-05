import { PDFDocument } from 'pdf-lib';
import type { DataStore, DocContentStore } from './store/index.js';
import { docPath } from './store/index.js';

/**
 * Append the QBR's attached PDF reports (Huntress summary, emailed vendor
 * reports, uploads) to the back of the rendered report PDF, so the single
 * deliverable carries the source material. Unreadable or encrypted
 * attachments are skipped — they never break the main report.
 */
export async function appendPdfAttachments(main: Buffer, attachments: Buffer[]): Promise<Buffer> {
  if (attachments.length === 0) return main;
  const out = await PDFDocument.load(main);
  let appended = 0;
  for (const bytes of attachments) {
    try {
      const src = await PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      for (const page of pages) out.addPage(page);
      appended++;
    } catch {
      // Skip corrupt/locked PDFs — the appendix still lists them by name.
    }
  }
  if (appended === 0) return main;
  return Buffer.from(await out.save());
}

/**
 * First `maxPages` pages of a PDF (input returned unchanged when already
 * within the cap, or unreadable). The AI matcher/extractor pay input tokens
 * per page — a 60-page carrier report doesn't need to ride along whole.
 */
export async function pdfFirstPages(bytes: Buffer, maxPages: number): Promise<Buffer> {
  try {
    const src = await PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true });
    if (src.getPageCount() <= maxPages) return bytes;
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, [...Array(maxPages).keys()]);
    for (const page of pages) out.addPage(page);
    return Buffer.from(await out.save());
  } catch {
    return bytes;
  }
}

/** Load the bytes of every attached PDF document for a client/period. */
export async function loadPdfAttachments(store: DataStore, docs: DocContentStore, clientId: string, period: string): Promise<Buffer[]> {
  const records = (await store.listDocuments(clientId, period)).filter((d) => /pdf/i.test(d.contentType) || /\.pdf$/i.test(d.name));
  const out: Buffer[] = [];
  for (const r of records.sort((a, b) => (a.uploadedAt < b.uploadedAt ? -1 : 1))) {
    const bytes = await docs.get(docPath(clientId, period, r.id, r.name)).catch(() => undefined);
    if (bytes) out.push(bytes);
  }
  return out;
}
