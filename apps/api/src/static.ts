import { existsSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

export interface StaticFile {
  file: string;
  contentType: string;
  /** Cache-Control the response should carry. */
  cacheControl: string;
}

/** Vite emits content-hashed files under assets/ — safe to cache forever. */
const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

/**
 * Baseline security headers for every response this app serves. SAMEORIGIN
 * (not DENY): the Report tab embeds report.html in a same-origin iframe.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'same-origin',
};

export function contentTypeFor(file: string): string {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** Does the final path segment carry a file extension? */
function hasExtension(path: string): boolean {
  const last = path.split('/').pop() ?? '';
  return last.includes('.');
}

/**
 * Resolve a request path to a static file inside `wwwDir`, with SPA fallback.
 * Pure and unit-testable. Returns null for API paths (so they fall through to
 * the real API routes), for path-traversal attempts, and for missing files
 * that carry an extension (a missing asset must 404, not serve index.html).
 */
export function resolveStaticFile(wwwDir: string, requestPath: string): StaticFile | null {
  const clean = (requestPath.split('?')[0] ?? '').replace(/^\/+/, '');
  if (clean.startsWith('api/') || clean === 'api') return null;

  const root = resolve(wwwDir);
  if (clean !== '') {
    const candidate = resolve(root, normalize(clean));
    if ((candidate === root || candidate.startsWith(root + '/')) && existsSync(candidate) && statSync(candidate).isFile()) {
      const cacheControl = clean.startsWith('assets/') ? IMMUTABLE : NO_CACHE;
      return { file: candidate, contentType: contentTypeFor(candidate), cacheControl };
    }
    // Missing file with an extension (e.g. a stale hashed bundle) -> 404.
    if (hasExtension(clean)) return null;
  }
  // SPA fallback: extension-less routes serve index.html for client-side routing.
  const index = join(root, 'index.html');
  if (existsSync(index)) return { file: index, contentType: CONTENT_TYPES['.html']!, cacheControl: NO_CACHE };
  return null;
}
