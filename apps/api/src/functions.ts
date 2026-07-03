import { app, type HttpMethod, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { SECURITY_HEADERS } from './static.js';
import { actorFrom, principalFrom } from './auth.js';
import { runWithActor } from './requestContext.js';
import * as h from './handlers.js';
import type { ApiResult } from './handlers.js';
import type { ConnectionInput } from './connections.js';
import type { PushInput } from './actions.js';
import './spa.js'; // registers the catch-all route that serves the React SPA

const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function toResponse(r: ApiResult): HttpResponseInit {
  const sec = SECURITY_HEADERS;
  if (r.html !== undefined) return { status: r.status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...sec }, body: r.html };
  if (r.pdf !== undefined) return { status: r.status, headers: { 'Content-Type': 'application/pdf', ...sec }, body: r.pdf };
  if (r.pptx !== undefined) return { status: r.status, headers: { 'Content-Type': PPTX, 'Content-Disposition': 'attachment', ...sec }, body: r.pptx };
  if (r.file !== undefined) {
    return {
      status: r.status,
      headers: {
        'Content-Type': r.file.contentType,
        'Content-Disposition': `attachment; filename="${r.file.filename.replace(/["\\]/g, '')}"`,
        ...sec,
      },
      body: r.file.bytes,
    };
  }
  return { status: r.status, jsonBody: r.json, headers: sec };
}

const ai = (req: HttpRequest) => req.query.get('ai');
const body = async (req: HttpRequest) => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
const headerGet = (req: HttpRequest) => (name: string) => req.headers.get(name);
const route = (name: string, method: HttpMethod, r: string, fn: (req: HttpRequest) => Promise<ApiResult> | ApiResult) =>
  app.http(name, {
    route: r,
    methods: [method],
    authLevel: 'anonymous',
    // Actor context lets handlers attribute audit entries to the Easy Auth user.
    handler: async (req) => runWithActor(actorFrom(headerGet(req)), async () => toResponse(await fn(req))),
  });

// Clients + report
route('listClients', 'GET', 'api/clients', () => h.listClients());
route('updateClient', 'PUT', 'api/clients/{clientId}', async (req) => h.updateClient(req.params['clientId']!, await body(req)));
route('importHalo', 'POST', 'api/clients/import/halo', () => h.importHalo());
route('getQbr', 'GET', 'api/clients/{clientId}/qbr/{period}', (req) => h.getQbr(req.params['clientId']!, req.params['period']!, ai(req)));
route('getReportHtml', 'GET', 'api/clients/{clientId}/qbr/{period}/report.html', (req) => h.getReportHtml(req.params['clientId']!, req.params['period']!, ai(req)));
route('getReportPdf', 'GET', 'api/clients/{clientId}/qbr/{period}/report.pdf', (req) => h.getReportPdf(req.params['clientId']!, req.params['period']!, ai(req)));
route('getReportDeck', 'GET', 'api/clients/{clientId}/qbr/{period}/deck.pptx', (req) => h.getReportDeck(req.params['clientId']!, req.params['period']!, ai(req)));

// Narrative editor
route('getNarrative', 'GET', 'api/clients/{clientId}/qbr/{period}/narrative', (req) => h.getNarrativeState(req.params['clientId']!, req.params['period']!));
route('putNarrative', 'PUT', 'api/clients/{clientId}/qbr/{period}/narrative', async (req) => h.putNarrativeEdits(req.params['clientId']!, req.params['period']!, await body(req)));
route('regenNarrative', 'POST', 'api/clients/{clientId}/qbr/{period}/narrative/regenerate', (req) => h.regenerateNarrative(req.params['clientId']!, req.params['period']!));

// Data review
route('getMetrics', 'GET', 'api/clients/{clientId}/qbr/{period}/metrics', (req) => h.getMetrics(req.params['clientId']!, req.params['period']!));
route('putMetrics', 'PUT', 'api/clients/{clientId}/qbr/{period}/metrics', async (req) => h.putManualMetrics(req.params['clientId']!, req.params['period']!, await body(req)));

// Attached documents
route('listDocs', 'GET', 'api/clients/{clientId}/qbr/{period}/documents', (req) => h.listQbrDocuments(req.params['clientId']!, req.params['period']!));
route('uploadDoc', 'POST', 'api/clients/{clientId}/qbr/{period}/documents', async (req) => h.uploadQbrDocument(req.params['clientId']!, req.params['period']!, (await body(req)) as never));
route('downloadDoc', 'GET', 'api/clients/{clientId}/qbr/{period}/documents/{docId}', (req) => h.downloadQbrDocument(req.params['clientId']!, req.params['period']!, req.params['docId']!));
route('deleteDoc', 'DELETE', 'api/clients/{clientId}/qbr/{period}/documents/{docId}', (req) => h.deleteQbrDocument(req.params['clientId']!, req.params['period']!, req.params['docId']!));

// Config + discussion
route('getConfig', 'GET', 'api/clients/{clientId}/config', (req) => h.getConfig(req.params['clientId']!));
route('putConfig', 'PUT', 'api/clients/{clientId}/config', async (req) => h.putConfig(req.params['clientId']!, await body(req)));
route('getDiscussion', 'GET', 'api/clients/{clientId}/qbr/{period}/discussion', (req) => h.getDiscussion(req.params['clientId']!, req.params['period']!));
route('putDiscussion', 'PUT', 'api/clients/{clientId}/qbr/{period}/discussion', async (req) => h.putDiscussion(req.params['clientId']!, req.params['period']!, await body(req)));

// Live pipeline + workflow
route('syncQbr', 'POST', 'api/clients/{clientId}/qbr/{period}/sync', (req) => h.syncQbr(req.params['clientId']!, req.params['period']!));
route('putStatus', 'PUT', 'api/clients/{clientId}/qbr/{period}/status', async (req) => h.putStatus(req.params['clientId']!, req.params['period']!, (await body(req))['status']));
route('putSchedule', 'PUT', 'api/clients/{clientId}/qbr/{period}/schedule', async (req) => h.putSchedule(req.params['clientId']!, req.params['period']!, (await body(req)) as { scheduledAt?: string; joinUrl?: string }));
route('pushAction', 'POST', 'api/clients/{clientId}/qbr/{period}/actions/push', async (req) => h.pushQbrAction(req.params['clientId']!, req.params['period']!, (await body(req)) as { actionId?: string; target: PushInput['target'] }));
route('emailQbr', 'POST', 'api/clients/{clientId}/qbr/{period}/email', async (req) => h.emailQbr(req.params['clientId']!, req.params['period']!, (await body(req)) as never, headerGet(req)));
route('createMeeting', 'POST', 'api/clients/{clientId}/qbr/{period}/meeting', async (req) => h.createMeeting(req.params['clientId']!, req.params['period']!, (await body(req)) as never, headerGet(req)));

// Integrations
route('listIntegrations', 'GET', 'api/integrations', () => h.listIntegrations());
route('createIntegration', 'POST', 'api/integrations', async (req) => h.saveIntegration((await body(req)) as unknown as ConnectionInput));
route('updateIntegration', 'PUT', 'api/integrations/{id}', async (req) => h.saveIntegration({ ...((await body(req)) as unknown as ConnectionInput), id: req.params['id']! }));
route('deleteIntegration', 'DELETE', 'api/integrations/{id}', (req) => h.deleteIntegration(req.params['id']!));
route('testIntegration', 'POST', 'api/integrations/{id}/test', (req) => h.testIntegration(req.params['id']!));
route('integrationOrgs', 'GET', 'api/integrations/{id}/orgs', (req) => h.getIntegrationOrgs(req.params['id']!));
route('haloMeta', 'GET', 'api/integrations/halo/meta', () => h.getHaloMeta());
route('integrationMappings', 'PUT', 'api/integrations/{id}/mappings', async (req) => h.putIntegrationMappings(req.params['id']!, (await body(req)) as never));

route('currentPeriod', 'GET', 'api/period/current', () => h.currentPeriod());
route('system', 'GET', 'api/system', () => h.getSystem());
route('overview', 'GET', 'api/overview', (req) => h.getOverview(req.query.get('current')));
route('clientPeriods', 'GET', 'api/clients/{clientId}/periods', (req) => h.getPeriods(req.params['clientId']!, req.query.get('current')));
route('me', 'GET', 'api/me', (req) => h.getMe(principalFrom(headerGet(req))));
route('audit', 'GET', 'api/audit', (req) => h.getAudit(req.query.get('limit')));

// Keeps a worker warm on the Consumption plan (softens cold starts; timers
// ride the existing AzureWebJobsStorage and run singleton across instances).
app.timer('keepWarm', {
  schedule: '0 */5 * * * *',
  handler: async () => {},
});
