/**
 * `Content-Disposition: attachment` with both an ASCII `filename` fallback and
 * an RFC 5987 / RFC 6266 `filename*` carrying the real UTF-8 name. Control
 * characters (CR/LF included), quotes and backslashes are removed first so a
 * crafted document name cannot split or break the header.
 */
export function contentDisposition(name: string, opts?: { inline?: boolean }): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f"\\]/g, '').trim() || 'download';
  const ascii =
    clean
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '') // combining accents: é -> e
      .replace(/[\u2010-\u2015\u2212]/g, '-') // hyphen/dash family -> -
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[^\x20-\x7e]/g, '_')
      .trim() || 'download';
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${opts?.inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** `Mash IT QBR - {Client} - {Q2 2026}.pdf`, with characters unsafe in file names removed from the client. */
export function deliverableFilename(clientName: string, periodLabel: string, ext: 'pdf' | 'html' | 'pptx'): string {
  const safe = clientName.replace(/[^\w .&()-]+/g, '').replace(/\s+/g, ' ').trim() || 'Client';
  return `Mash IT QBR - ${safe} - ${periodLabel}.${ext}`;
}
