/**
 * Request-body parsing shared by both routers. A malformed body must surface as
 * a 400, never as `{}` (which write handlers would happily persist).
 */

/** `{}` for an empty body, the object for a JSON object, else null. */
export function parseBody(text: string): Record<string, unknown> | null {
  if (!text.trim()) return {};
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Thrown by a router's body reader; the router maps it to a 400. */
export class InvalidBodyError extends Error {
  constructor() {
    super('Invalid JSON body');
  }
}

export const INVALID_BODY = { status: 400, json: { error: 'Invalid JSON body' } } as const;
