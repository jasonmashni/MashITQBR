import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStaticFile } from '../src/static.js';

let www: string;

beforeAll(() => {
  www = mkdtempSync(join(tmpdir(), 'qbr-www-'));
  writeFileSync(join(www, 'index.html'), '<!doctype html><title>QBR</title>');
  mkdirSync(join(www, 'assets'));
  writeFileSync(join(www, 'assets', 'app.js'), 'console.log(1)');
});
afterAll(() => rmSync(www, { recursive: true, force: true }));

describe('resolveStaticFile', () => {
  it('serves the root as index.html (never cached)', () => {
    const m = resolveStaticFile(www, '');
    expect(m?.file.endsWith('index.html')).toBe(true);
    expect(m?.contentType).toContain('text/html');
    expect(m?.cacheControl).toBe('no-cache');
  });

  it('serves an existing asset with its content-type and immutable caching', () => {
    const m = resolveStaticFile(www, 'assets/app.js');
    expect(m?.file.endsWith('app.js')).toBe(true);
    expect(m?.contentType).toContain('javascript');
    expect(m?.cacheControl).toContain('immutable');
  });

  it('falls back to index.html for unknown client-side routes', () => {
    const m = resolveStaticFile(www, 'some/spa/route');
    expect(m?.file.endsWith('index.html')).toBe(true);
    expect(m?.cacheControl).toBe('no-cache');
  });

  it('404s a missing file that carries an extension (stale hashed bundle)', () => {
    expect(resolveStaticFile(www, 'assets/gone.js')).toBeNull();
    expect(resolveStaticFile(www, 'favicon.ico')).toBeNull();
  });

  it('returns null for API paths so they fall through to the API', () => {
    expect(resolveStaticFile(www, 'api/clients')).toBeNull();
    expect(resolveStaticFile(www, '/api/period/current')).toBeNull();
  });

  it('blocks path traversal outside the web root', () => {
    // Escaping the root resolves to the SPA fallback, never a file outside it.
    const m = resolveStaticFile(www, '../../../etc/passwd');
    expect(m?.file.endsWith('index.html')).toBe(true);
  });
});
