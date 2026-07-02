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
}

export function contentTypeFor(file: string): string {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Resolve a request path to a static file inside `wwwDir`, with SPA fallback.
 * Pure and unit-testable. Returns null for API paths (so they fall through to
 * the real API routes) and for path-traversal attempts.
 */
export function resolveStaticFile(wwwDir: string, requestPath: string): StaticFile | null {
  const clean = (requestPath.split('?')[0] ?? '').replace(/^\/+/, '');
  if (clean.startsWith('api/') || clean === 'api') return null;

  const root = resolve(wwwDir);
  if (clean !== '') {
    const candidate = resolve(root, normalize(clean));
    if ((candidate === root || candidate.startsWith(root + '/')) && existsSync(candidate) && statSync(candidate).isFile()) {
      return { file: candidate, contentType: contentTypeFor(candidate) };
    }
  }
  // SPA fallback: any non-file route serves index.html for client-side routing.
  const index = join(root, 'index.html');
  if (existsSync(index)) return { file: index, contentType: CONTENT_TYPES['.html']! };
  return null;
}
