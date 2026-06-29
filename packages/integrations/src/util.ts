/** Unwrap an MCP tool-call result into its payload (text JSON, structured, or raw). */
export function unwrapMcp(result: unknown): unknown {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (r['structuredContent'] !== undefined) return r['structuredContent'];
    if (Array.isArray(r['content'])) {
      const block = (r['content'] as Array<Record<string, unknown>>).find(
        (b) => b && b['type'] === 'text' && typeof b['text'] === 'string',
      );
      if (block) {
        const text = block['text'] as string;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
    }
  }
  return result;
}

/** Coerce a possibly-wrapped JSON payload to an array of T. */
export function toArray<T>(json: unknown, keys: string[] = []): T[] {
  if (Array.isArray(json)) return json as T[];
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    for (const k of [...keys, 'data', 'results', 'items']) {
      if (Array.isArray(obj[k])) return obj[k] as T[];
    }
  }
  return [];
}
