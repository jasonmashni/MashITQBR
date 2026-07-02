import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { periodFor, type QbrDiscussion, type ReportConfig } from '@mashit/core';
import { createClaudeNarrativeModel, type NarrativeModel } from '@mashit/narrative';
import { renderDeck, renderPdf } from '@mashit/report';
import { seedDataSource } from './dataSource.js';
import { buildQbrReport, renderQbrHtml } from './service.js';
import { getConfig, getDiscussion, loadReportInputs, putConfig, putDiscussion } from './store.js';
import './spa.js'; // registers the catch-all route that serves the React SPA

/** Use Claude when a key is configured and the request didn't opt out (?ai=0). */
function narrativeModelFor(req: HttpRequest): NarrativeModel | undefined {
  const aiOff = req.query.get('ai') === '0';
  if (!aiOff && process.env['ANTHROPIC_API_KEY']) return createClaudeNarrativeModel();
  return undefined;
}

function json(status: number, body: unknown): HttpResponseInit {
  return { status, jsonBody: body };
}

app.http('listClients', {
  route: 'api/clients',
  methods: ['GET'],
  authLevel: 'anonymous', // Static Web Apps Easy Auth gates access in front of the API
  handler: async (): Promise<HttpResponseInit> => json(200, { clients: seedDataSource.listClients() }),
});

app.http('getQbr', {
  route: 'api/clients/{clientId}/qbr/{period}',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> => {
    const { clientId, period } = req.params;
    try {
      const report = await buildQbrReport(seedDataSource, clientId!, period!, {
        narrativeModel: narrativeModelFor(req),
        ...loadReportInputs(clientId!, period!),
      });
      return json(200, { model: report.model, warnings: report.warnings, verification: report.narrative.verification.ok });
    } catch (err) {
      ctx.error(err);
      return json(404, { error: err instanceof Error ? err.message : 'Not found' });
    }
  },
});

app.http('getQbrHtml', {
  route: 'api/clients/{clientId}/qbr/{period}/report.html',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    const { clientId, period } = req.params;
    const report = await buildQbrReport(seedDataSource, clientId!, period!, { narrativeModel: narrativeModelFor(req), ...loadReportInputs(clientId!, period!) });
    return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: renderQbrHtml(report) };
  },
});

app.http('getQbrPdf', {
  route: 'api/clients/{clientId}/qbr/{period}/report.pdf',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    const { clientId, period } = req.params;
    const report = await buildQbrReport(seedDataSource, clientId!, period!, { narrativeModel: narrativeModelFor(req), ...loadReportInputs(clientId!, period!) });
    try {
      const pdf = await renderPdf(renderQbrHtml(report), {
        executablePath: process.env['PLAYWRIGHT_CHROMIUM_PATH'],
      });
      return {
        status: 200,
        headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${clientId}-${period}-QBR.pdf"` },
        body: pdf,
      };
    } catch (err) {
      return json(501, { error: err instanceof Error ? err.message : 'PDF rendering unavailable' });
    }
  },
});

app.http('getQbrDeck', {
  route: 'api/clients/{clientId}/qbr/{period}/deck.pptx',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    const { clientId, period } = req.params;
    const report = await buildQbrReport(seedDataSource, clientId!, period!, { narrativeModel: narrativeModelFor(req), ...loadReportInputs(clientId!, period!) });
    try {
      const deck = await renderDeck(report.model);
      return {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'Content-Disposition': `attachment; filename="${clientId}-${period}-QBR.pptx"`,
        },
        body: deck,
      };
    } catch (err) {
      return json(501, { error: err instanceof Error ? err.message : 'Deck rendering unavailable' });
    }
  },
});

// ── Per-client report config (branding + sections) ──
app.http('getConfig', {
  route: 'api/clients/{clientId}/config',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    const { clientId } = req.params;
    return json(200, getConfig(clientId!) ?? { clientId });
  },
});

app.http('putConfig', {
  route: 'api/clients/{clientId}/config',
  methods: ['PUT'],
  authLevel: 'anonymous',
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    const { clientId } = req.params;
    const body = (await req.json()) as Partial<ReportConfig>;
    return json(200, putConfig({ ...body, clientId: clientId! }));
  },
});

// ── Per-QBR discussion + notes capture ──
app.http('getDiscussion', {
  route: 'api/clients/{clientId}/qbr/{period}/discussion',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    const { clientId, period } = req.params;
    return json(200, getDiscussion(clientId!, period!) ?? { clientId, period, items: [] });
  },
});

app.http('putDiscussion', {
  route: 'api/clients/{clientId}/qbr/{period}/discussion',
  methods: ['PUT'],
  authLevel: 'anonymous',
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    const { clientId, period } = req.params;
    const body = (await req.json()) as Partial<QbrDiscussion>;
    return json(200, putDiscussion({ clientId: clientId!, period: period!, items: body.items ?? [], notes: body.notes }));
  },
});

/** Convenience: current quarter id for the UI's default selection. */
app.http('currentPeriod', {
  route: 'api/period/current',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (): Promise<HttpResponseInit> => json(200, { period: periodFor(new Date()).id }),
});
