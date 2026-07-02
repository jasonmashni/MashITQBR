/**
 * Parsers for the MASH MCP server's tool output. Its tools return
 * human-formatted TEXT (built for LLM chat), not JSON — e.g.:
 *
 *   Found 3 client(s):
 *     [35] Addiction Recovery Care
 *
 *   Organizations (9 total):
 *     [1] Mash IT | Internal Infrastructure
 *
 *   Antivirus Status (3 results):
 *     {"productName": "Microsoft Defender Antivirus", "productState": "ON", ...}
 *
 *   [17] ANP-LAP-005 | Org: 3 | Role: 202 | Status: Unknown | OS:
 *
 * Callers should always try JSON first (unwrapMcp already parses JSON text and
 * structuredContent) and fall back to these — so if the MCP server ever adds
 * structured output, it is preferred automatically.
 */

export interface IdName {
  id: string;
  name: string;
}

/** Coerce an unwrapped MCP payload to text (already-parsed JSON returns null). */
export function asText(payload: unknown): string | null {
  return typeof payload === 'string' ? payload : null;
}

/** `[id] Name` lines → [{id, name}] (halo_list_clients, ninja_list_organizations). */
export function parseIdNameList(text: string): IdName[] {
  const out: IdName[] = [];
  for (const m of text.matchAll(/^\s*\[(\w+)\]\s+(.+?)\s*$/gm)) {
    // Pipe-delimited rows are handled by parsePipeRows; take only the name part here.
    const name = m[2]!.split('|')[0]!.trim();
    if (name) out.push({ id: m[1]!, name });
  }
  return out;
}

export interface PipeRow {
  id: string;
  name: string;
  fields: Record<string, string>;
}

/** `[id] NAME | Key: v | Key: v` lines → rows with parsed fields (ninja device lists). */
export function parsePipeRows(text: string): PipeRow[] {
  const out: PipeRow[] = [];
  for (const m of text.matchAll(/^\s*\[(\w+)\]\s+(.+?)\s*$/gm)) {
    const parts = m[2]!.split('|').map((p) => p.trim());
    const fields: Record<string, string> = {};
    for (const part of parts.slice(1)) {
      const kv = /^([^:]+):\s*(.*)$/.exec(part);
      if (kv) fields[kv[1]!.trim().toLowerCase()] = kv[2]!.trim();
    }
    out.push({ id: m[1]!, name: parts[0] ?? '', fields });
  }
  return out;
}

/** One JSON object per line (ninja_query_* batch tools) → parsed objects. */
export function parseJsonLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const obj = JSON.parse(trimmed) as unknown;
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) out.push(obj as Record<string, unknown>);
    } catch {
      /* not a JSON line — skip */
    }
  }
  return out;
}

/**
 * Total from a header like `Found 141 ticket(s):`, `Organizations (9 total):`,
 * or `Antivirus Status (3 results):`. Null when no count is present.
 */
export function headerCount(text: string): number | null {
  const m =
    /Found\s+(\d+)\s/i.exec(text) ??
    /\((\d+)\s+(?:total|results?|returned)\)/i.exec(text) ??
    /^\s*(\d+)\s+\w+\(s\)/m.exec(text);
  return m ? Number(m[1]) : null;
}
