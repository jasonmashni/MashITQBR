/**
 * Local development API server — mirrors the Azure Functions routes using the
 * same service layer, so the React app runs without Azure Functions Core Tools.
 *
 *   node apps/api/dist/devserver.js   (listens on :7071)
 */
import { createServer } from 'node:http';
import { periodFor } from '@mashit/core';
import { createClaudeNarrativeModel, type NarrativeModel } from '@mashit/narrative';
import { renderDeck, renderPdf } from '@mashit/report';
import { seedDataSource } from './dataSource.js';
import { buildQbrReport, renderQbrHtml } from './service.js';

const PORT = Number(process.env['PORT'] ?? 7071);

function modelFor(url: URL): NarrativeModel | undefined {
  const aiOff = url.searchParams.get('ai') === '0';
  return process.env['ANTHROPIC_API_KEY'] && !aiOff ? createClaudeNarrativeModel() : undefined;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '');
  const send = (status: number, type: string, body: string | Buffer) => {
    res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  };
  const json = (status: number, obj: unknown) => send(status, 'application/json', JSON.stringify(obj));

  try {
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    if (path === '/api/clients') return json(200, { clients: seedDataSource.listClients() });
    if (path === '/api/period/current') return json(200, { period: periodFor(new Date()).id });

    const m = path.match(/^\/api\/clients\/([^/]+)\/qbr\/([^/]+)(\/report\.html|\/report\.pdf|\/deck\.pptx)?$/);
    if (m) {
      const clientId = m[1]!;
      const period = m[2]!;
      const kind = m[3];
      const report = await buildQbrReport(seedDataSource, clientId, period, { narrativeModel: modelFor(url) });

      if (kind === '/report.html') return send(200, 'text/html; charset=utf-8', renderQbrHtml(report));
      if (kind === '/report.pdf') {
        try {
          const pdf = await renderPdf(renderQbrHtml(report), { executablePath: process.env['PLAYWRIGHT_CHROMIUM_PATH'] });
          return send(200, 'application/pdf', pdf);
        } catch (err) {
          return json(501, { error: err instanceof Error ? err.message : 'PDF rendering unavailable' });
        }
      }
      if (kind === '/deck.pptx') {
        try {
          const deck = await renderDeck(report.model);
          return send(200, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', deck);
        } catch (err) {
          return json(501, { error: err instanceof Error ? err.message : 'Deck rendering unavailable' });
        }
      }
      return json(200, { model: report.model, warnings: report.warnings, verification: report.narrative.verification.ok });
    }

    return json(404, { error: 'Not found' });
  } catch (err) {
    json(err instanceof Error && /Unknown client|No metric snapshot/.test(err.message) ? 404 : 500, {
      error: err instanceof Error ? err.message : 'Server error',
    });
  }
});

server.listen(PORT, () => console.log(`QBR dev API on http://localhost:${PORT}`));
