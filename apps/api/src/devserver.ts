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
import * as h from './handlers.js';
import type { ApiResult } from './handlers.js';
import type { ConnectionInput } from './connections.js';
import type { PushInput } from './actions.js';
import { actorFrom, principalFrom } from './auth.js';
import { runWithActor } from './requestContext.js';
import { resolveStaticFile, SECURITY_HEADERS } from './static.js';

const PORT = Number(process.env['PORT'] ?? 7071);
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = [resolve(HERE, '..', 'www'), resolve(process.cwd(), 'apps/web/dist'), resolve(process.cwd(), 'apps/api/www')].find(
  (d) => existsSync(join(d, 'index.html')),
);

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

type HeaderGet = (name: string) => string | undefined;

interface Route {
  method: string;
  re: RegExp;
  run: (m: RegExpMatchArray, body: Record<string, unknown>, url: URL, header: HeaderGet) => Promise<ApiResult> | ApiResult;
}

const routes: Route[] = [
  { method: 'GET', re: /^\/api\/clients$/, run: () => h.listClients() },
  { method: 'POST', re: /^\/api\/clients\/import\/halo$/, run: () => h.importHalo() },
  { method: 'PUT', re: /^\/api\/clients\/([^/]+)$/, run: (m, b) => h.updateClient(m[1]!, b) },
  { method: 'GET', re: /^\/api\/clients\/([^/]+)\/opportunities$/, run: (m) => h.listOpportunities(m[1]!) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/opportunities$/, run: (m, b) => h.putOpportunity(m[1]!, b) },
  { method: 'DELETE', re: /^\/api\/clients\/([^/]+)\/opportunities\/([^/]+)$/, run: (m) => h.deleteOpportunity(m[1]!, m[2]!) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/opportunities\/([^/]+)\/push$/, run: (m, b) => h.pushOpportunity(m[1]!, m[2]!, b as never) },
  { method: 'GET', re: /^\/api\/clients\/([^/]+)\/config$/, run: (m) => h.getConfig(m[1]!) },
  { method: 'PUT', re: /^\/api\/clients\/([^/]+)\/config$/, run: (m, b) => h.putConfig(m[1]!, b) },
  { method: 'GET', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)$/, run: (m, _b, url) => h.getQbr(m[1]!, m[2]!, url.searchParams.get('ai')) },
  { method: 'GET', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/report\.html$/, run: (m, _b, url) => h.getReportHtml(m[1]!, m[2]!, url.searchParams.get('ai')) },
  { method: 'GET', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/report\.pdf$/, run: (m, _b, url) => h.getReportPdf(m[1]!, m[2]!, url.searchParams.get('ai')) },
  { method: 'GET', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/deck\.pptx$/, run: (m, _b, url) => h.getReportDeck(m[1]!, m[2]!, url.searchParams.get('ai')) },
  { method: 'GET', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/narrative$/, run: (m) => h.getNarrativeState(m[1]!, m[2]!) },
  { method: 'PUT', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/narrative$/, run: (m, b) => h.putNarrativeEdits(m[1]!, m[2]!, b) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/narrative\/regenerate$/, run: (m) => h.regenerateNarrative(m[1]!, m[2]!) },
  { method: 'GET', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/metrics$/, run: (m) => h.getMetrics(m[1]!, m[2]!) },
  { method: 'PUT', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/metrics$/, run: (m, b) => h.putManualMetrics(m[1]!, m[2]!, b) },
  { method: 'GET', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/documents$/, run: (m) => h.listQbrDocuments(m[1]!, m[2]!) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/documents$/, run: (m, b) => h.uploadQbrDocument(m[1]!, m[2]!, b as never) },
  { method: 'GET', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/documents\/([^/]+)$/, run: (m) => h.downloadQbrDocument(m[1]!, m[2]!, m[3]!) },
  { method: 'PATCH', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/documents\/([^/]+)$/, run: (m, b) => h.updateQbrDocument(m[1]!, m[2]!, m[3]!, b) },
  { method: 'GET', re: /^\/api\/clients\/([^/]+)\/documents$/, run: (m) => h.listClientDocuments(m[1]!) },
  { method: 'DELETE', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/documents\/([^/]+)$/, run: (m) => h.deleteQbrDocument(m[1]!, m[2]!, m[3]!) },
  { method: 'GET', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/discussion$/, run: (m) => h.getDiscussion(m[1]!, m[2]!) },
  { method: 'PUT', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/discussion$/, run: (m, b) => h.putDiscussion(m[1]!, m[2]!, b) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/sync$/, run: (m) => h.syncQbr(m[1]!, m[2]!) },
  { method: 'PUT', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/status$/, run: (m, b) => h.putStatus(m[1]!, m[2]!, b['status']) },
  { method: 'PUT', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/schedule$/, run: (m, b) => h.putSchedule(m[1]!, m[2]!, b as { scheduledAt?: string; joinUrl?: string }) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/actions\/push$/, run: (m, b) => h.pushQbrAction(m[1]!, m[2]!, b as { actionId?: string; target: PushInput['target'] }) },
  { method: 'GET', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/email\.eml$/, run: (m, _b, url) => h.getEmailDraft(m[1]!, m[2]!, url.searchParams.get('ai')) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/email$/, run: (m, b, _u, header) => h.emailQbr(m[1]!, m[2]!, b as never, header) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/meeting$/, run: (m, b, _u, header) => h.createMeeting(m[1]!, m[2]!, b as never, header) },
  { method: 'GET', re: /^\/api\/integrations$/, run: () => h.listIntegrations() },
  { method: 'POST', re: /^\/api\/integrations$/, run: (_m, b) => h.saveIntegration(b as unknown as ConnectionInput) },
  { method: 'PUT', re: /^\/api\/integrations\/([^/]+)$/, run: (m, b) => h.saveIntegration({ ...(b as unknown as ConnectionInput), id: m[1]! }) },
  { method: 'DELETE', re: /^\/api\/integrations\/([^/]+)$/, run: (m) => h.deleteIntegration(m[1]!) },
  { method: 'POST', re: /^\/api\/integrations\/([^/]+)\/test$/, run: (m) => h.testIntegration(m[1]!) },
  { method: 'GET', re: /^\/api\/integrations\/halo\/meta$/, run: (_m, _b, url) => h.getHaloMeta(url.searchParams.get('connectionId')) },
  { method: 'GET', re: /^\/api\/integrations\/ninja\/meta$/, run: (_m, _b, url) => h.getNinjaMeta(url.searchParams.get('connectionId')) },
  { method: 'GET', re: /^\/api\/integrations\/([^/]+)\/orgs$/, run: (m) => h.getIntegrationOrgs(m[1]!) },
  { method: 'PUT', re: /^\/api\/integrations\/([^/]+)\/mappings$/, run: (m, b) => h.putIntegrationMappings(m[1]!, b as never) },
  { method: 'GET', re: /^\/api\/settings\/org$/, run: () => h.getOrgSettings() },
  { method: 'PUT', re: /^\/api\/settings\/org$/, run: (_m, b) => h.putOrgSettings(b) },
  { method: 'GET', re: /^\/api\/period\/current$/, run: () => h.currentPeriod() },
  { method: 'GET', re: /^\/api\/system$/, run: () => h.getSystem() },
  { method: 'GET', re: /^\/api\/system-info$/, run: () => h.getSystem() },
  { method: 'GET', re: /^\/api\/capabilities$/, run: () => h.getSystem() },
  { method: 'GET', re: /^\/api\/overview$/, run: (_m, _b, url) => h.getOverview(url.searchParams.get('current')) },
  { method: 'GET', re: /^\/api\/clients\/([^/]+)\/periods$/, run: (m, _b, url) => h.getPeriods(m[1]!, url.searchParams.get('current')) },
  { method: 'GET', re: /^\/api\/audit$/, run: (_m, _b, url) => h.getAudit(url.searchParams.get('limit')) },
  { method: 'POST', re: /^\/api\/inbox\/poll$/, run: () => h.pollInbox() },
  { method: 'GET', re: /^\/api\/me$/, run: (_m, _b, _url, header) => h.getMe(principalFrom(header)) },
  { method: 'POST', re: /^\/api\/inbox\/poll$/, run: () => h.pollInbox() },
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...SECURITY_HEADERS,
  };
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    const header: HeaderGet = (name) => {
      const v = req.headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    for (const rt of routes) {
      if (req.method !== rt.method) continue;
      const m = path.match(rt.re);
      if (!m) continue;
      const b = req.method === 'PUT' || req.method === 'POST' ? await readJson(req) : {};
      const result = await runWithActor(actorFrom(header), async () => rt.run(m, b, url, header));
      if (result.html !== undefined) { res.writeHead(result.status, { 'Content-Type': 'text/html; charset=utf-8', ...cors }); return res.end(result.html); }
      if (result.pdf !== undefined) { res.writeHead(result.status, { 'Content-Type': 'application/pdf', ...cors }); return res.end(result.pdf); }
      if (result.pptx !== undefined) { res.writeHead(result.status, { 'Content-Type': PPTX, 'Content-Disposition': 'attachment', ...cors }); return res.end(result.pptx); }
      if (result.file !== undefined) {
        res.writeHead(result.status, {
          'Content-Type': result.file.contentType,
          'Content-Disposition': `attachment; filename="${result.file.filename.replace(/["\\]/g, '')}"`,
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

server.listen(PORT, () => console.log(`QBR dev API on http://localhost:${PORT}`));
