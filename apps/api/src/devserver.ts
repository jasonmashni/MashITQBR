/**
 * Local development API server — same routes as the Azure Functions app, over
 * the shared handlers, plus SPA static serving. Lets the React app run without
 * Azure Functions Core Tools. Uses Table Storage/Key Vault when configured, else
 * the local JSON store + local secret file.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actorFrom } from './auth.js';
import { runWithActor } from './requestContext.js';
import { gate } from './gate.js';
import { INVALID_BODY, parseBody } from './body.js';
import { resolveStaticFile, SECURITY_HEADERS } from './static.js';
import { contentDisposition } from './contentDisposition.js';
import { routes, type HeaderGet } from './devRoutes.js';

const PORT = Number(process.env['PORT'] ?? 7071);
// Loopback only: the dev server has no Easy Auth in front of it.
const HOST = '127.0.0.1';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = [resolve(HERE, '..', 'www'), resolve(process.cwd(), 'apps/web/dist'), resolve(process.cwd(), 'apps/api/www')].find(
  (d) => existsSync(join(d, 'index.html')),
);

/** Parsed JSON object body, or null when it is malformed (the route answers 400). */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return parseBody(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  // No CORS headers: the web app reaches this server same-origin (Vite proxy
  // or the static SPA below), so cross-origin pages get nothing.
  const cors = { ...SECURITY_HEADERS };
  try {
    const header: HeaderGet = (name) => {
      const v = req.headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    for (const rt of routes) {
      if (req.method !== rt.method) continue;
      const m = path.match(rt.re);
      if (!m) continue;
      const b = req.method === 'PUT' || req.method === 'POST' || req.method === 'PATCH' ? await readJson(req) : {};
      const result = await runWithActor(actorFrom(header), async () =>
        gate(path, header, () => (b === null ? INVALID_BODY : rt.run(m, b, url, header))),
      );
      if (result.html !== undefined) { res.writeHead(result.status, { 'Content-Type': 'text/html; charset=utf-8', ...cors }); return res.end(result.html); }
      if (result.pdf !== undefined) { res.writeHead(result.status, { 'Content-Type': 'application/pdf', ...cors }); return res.end(result.pdf); }
      if (result.pptx !== undefined) {
        const cd = result.filename ? contentDisposition(result.filename) : 'attachment';
        res.writeHead(result.status, { 'Content-Type': PPTX, 'Content-Disposition': cd, ...cors });
        return res.end(result.pptx);
      }
      if (result.file !== undefined) {
        res.writeHead(result.status, {
          'Content-Type': result.file.contentType,
          'Content-Disposition': contentDisposition(result.file.filename),
          ...cors,
        });
        return res.end(result.file.bytes);
      }
      res.writeHead(result.status, { 'Content-Type': 'application/json', ...cors });
      return res.end(JSON.stringify(result.json));
    }

    // Static SPA (if a web build is present)
    if (req.method === 'GET' && WWW && !path.startsWith('/api/')) {
      const match = resolveStaticFile(WWW, path);
      if (match) {
        res.writeHead(200, { 'Content-Type': match.contentType, 'Cache-Control': match.cacheControl, ...cors });
        return res.end(await readFile(match.file));
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Server error' }));
  }
});

server.listen(PORT, HOST, () => console.log(`QBR dev API on http://${HOST}:${PORT}`));
