import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStaticFile, SECURITY_HEADERS } from './static.js';

/** Web root: the `www/` folder sits next to `dist/` at the deployed app root. */
function wwwDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'www');
}

// Catch-all: serve the built React SPA. API routes (registered with an explicit
// `api/` prefix) take precedence over this parameterized route.
app.http('spa', {
  route: '{*path}',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    const requested = req.params['path'] ?? '';
    const match = resolveStaticFile(wwwDir(), requested);
    if (!match) return { status: 404, jsonBody: { error: 'Not found' }, headers: SECURITY_HEADERS };
    const body = await readFile(match.file);
    return {
      status: 200,
      headers: { 'Content-Type': match.contentType, 'Cache-Control': match.cacheControl, ...SECURITY_HEADERS },
      body,
    };
  },
});
