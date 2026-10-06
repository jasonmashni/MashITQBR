import { describe, expect, it } from 'vitest';
import { contentDisposition } from '../src/contentDisposition.js';

describe('contentDisposition', () => {
  it('carries an ASCII fallback and an RFC 5987 UTF-8 name', () => {
    const cd = contentDisposition('Rapport – T3.pdf');
    expect(cd.startsWith('attachment; ')).toBe(true);
    expect(cd).toContain('filename="Rapport - T3.pdf"');
    expect(cd).toContain("filename*=UTF-8''Rapport%20%E2%80%93%20T3.pdf");
  });

  it('strips CR/LF and quote/backslash characters so the header cannot be split', () => {
    const cd = contentDisposition('evil\r\nSet-Cookie: x=1"\\.pdf');
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd).toContain('filename="evilSet-Cookie: x=1.pdf"');
  });

  it("percent-encodes the RFC 5987 attr-char exclusions (' ( ) *)", () => {
    expect(contentDisposition("O'Brien (Q3)*.pdf")).toContain("filename*=UTF-8''O%27Brien%20%28Q3%29%2A.pdf");
  });

  it('falls back to a generic name when nothing printable is left', () => {
    expect(contentDisposition('\r\n')).toContain('filename="download"');
  });
});
