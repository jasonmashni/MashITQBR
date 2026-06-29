/**
 * Local development API server — mirrors the Azure Functions routes using the
 * same service layer, so the React app runs without Azure Functions Core Tools.
 *
 *   node apps/api/dist/devserver.js   (listens on :7071)
 */
import { createServer, type IncomingMessage } from 'node:http';
import { periodFor, type QbrDiscussion, type ReportConfig } from '@mashit/core';
import { createClaudeNarrativeModel, type NarrativeModel } from '@mashit/narrative';
import { renderDeck, renderPdf } from '@mashit/report';
import { seedDataSource } from './dataSource.js';
import { buildQbrReport, renderQbrHtml } from './service.js';
import { getConfig, getDiscussion, loadReportInputs, putConfig, putDiscussion } from './store.js';

const PORT = Number(process.env['PORT'] ?? 7071);

function modelFor(url: URL): NarrativeModel | undefined {
  const aiOff = url.searchParams.get('ai') === '0';
  return process.env['ANTHROPIC_API_KEY'] && !aiOff ? createClaudeNarrativeModel() : undefined;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '');
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  const send = (status: number, type: string, body: string | Buffer) => {
    res.writeHead(status, { 'Content-Type': type, ...cors });
    res.end(body);
  };
  const json = (status: number, obj: unknown) => send(status, 'application/json', JSON.stringify(obj));

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }

    // ── Reads ──
    if (req.method === 'GET') {
      if (path === '/api/clients') return json(200, { clients: seedDataSource.listClients() });
      if (path === '/api/period/current') return json(200, { period: periodFor(new Date()).id });

      const cfg = path.match(/^\/api\/clients\/([^/]+)\/config$/);
      if (cfg) return json(200, getConfig(cfg[1]!) ?? { clientId: cfg[1]! });

      const disc = path.match(/^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/discussion$/);
      if (disc) return json(200, getDiscussion(disc[1]!, disc[2]!) ?? { clientId: disc[1]!, period: disc[2]!, items: [] });

      const m = path.match(/^\/api\/clients\/([^/]+)\/qbr\/([^/]+)(\/report\.html|\/report\.pdf|\/deck\.pptx)?$/);
      if (m) {
        const clientId = m[1]!;
        const period = m[2]!;
        const kind = m[3];
        const report = await buildQbrReport(seedDataSource, clientId, period, {
          narrativeModel: modelFor(url),
          ...loadReportInputs(clientId, period),
        });
        if (kind === '/report.html') return send(200, 'text/html; charset=utf-8', renderQbrHtml(report));
        if (kind === '/report.pdf') {
          try {
            return send(200, 'application/pdf', await renderPdf(renderQbrHtml(report), { executablePath: process.env['PLAYWRIGHT_CHROMIUM_PATH'] }));
          } catch (err) {
            return json(501, { error: err instanceof Error ? err.message : 'PDF rendering unavailable' });
          }
        }
        if (kind === '/deck.pptx') {
          try {
            return send(200, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', await renderDeck(report.model));
          } catch (err) {
            return json(501, { error: err instanceof Error ? err.message : 'Deck rendering unavailable' });
          }
        }
        return json(200, { model: report.model, warnings: report.warnings, verification: report.narrative.verification.ok });
      }
    }

    // ── Writes ──
    if (req.method === 'PUT') {
      const cfg = path.match(/^\/api\/clients\/([^/]+)\/config$/);
      if (cfg) {
        const body = (await readJson(req)) as Partial<ReportConfig>;
        return json(200, putConfig({ ...body, clientId: cfg[1]! }));
      }
      const disc = path.match(/^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/discussion$/);
      if (disc) {
        const body = (await readJson(req)) as Partial<QbrDiscussion>;
        return json(200, putDiscussion({ clientId: disc[1]!, period: disc[2]!, items: body.items ?? [], notes: body.notes }));
      }
    }

    return json(404, { error: 'Not found' });
  } catch (err) {
    json(err instanceof Error && /Unknown client|No metric snapshot/.test(err.message) ? 404 : 500, {
      error: err instanceof Error ? err.message : 'Server error',
    });
  }
});

server.listen(PORT, () => console.log(`QBR dev API on http://localhost:${PORT}`));
