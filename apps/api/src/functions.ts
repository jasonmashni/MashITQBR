import { app, type HttpMethod, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import type { QbrStatus } from '@mashit/core';
import * as h from './handlers.js';
import type { ApiResult } from './handlers.js';
import type { ConnectionInput } from './connections.js';
import type { PushInput } from './actions.js';
import './spa.js'; // registers the catch-all route that serves the React SPA

const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function toResponse(r: ApiResult): HttpResponseInit {
  if (r.html !== undefined) return { status: r.status, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: r.html };
  if (r.pdf !== undefined) return { status: r.status, headers: { 'Content-Type': 'application/pdf' }, body: r.pdf };
  if (r.pptx !== undefined) return { status: r.status, headers: { 'Content-Type': PPTX, 'Content-Disposition': 'attachment' }, body: r.pptx };
  return { status: r.status, jsonBody: r.json };
}

const ai = (req: HttpRequest) => req.query.get('ai');
const body = async (req: HttpRequest) => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
const route = (name: string, method: HttpMethod, r: string, fn: (req: HttpRequest) => Promise<ApiResult> | ApiResult) =>
  app.http(name, { route: r, methods: [method], authLevel: 'anonymous', handler: async (req) => toResponse(await fn(req)) });

// Clients + report
route('listClients', 'GET', 'api/clients', () => h.listClients());
route('updateClient', 'PUT', 'api/clients/{clientId}', async (req) => h.updateClient(req.params['clientId']!, await body(req)));
route('importHalo', 'POST', 'api/clients/import/halo', () => h.importHalo());
route('getQbr', 'GET', 'api/clients/{clientId}/qbr/{period}', (req) => h.getQbr(req.params['clientId']!, req.params['period']!, ai(req)));
route('getReportHtml', 'GET', 'api/clients/{clientId}/qbr/{period}/report.html', (req) => h.getReportHtml(req.params['clientId']!, req.params['period']!, ai(req)));
route('getReportPdf', 'GET', 'api/clients/{clientId}/qbr/{period}/report.pdf', (req) => h.getReportPdf(req.params['clientId']!, req.params['period']!, ai(req)));
route('getReportDeck', 'GET', 'api/clients/{clientId}/qbr/{period}/deck.pptx', (req) => h.getReportDeck(req.params['clientId']!, req.params['period']!, ai(req)));

// Config + discussion
route('getConfig', 'GET', 'api/clients/{clientId}/config', (req) => h.getConfig(req.params['clientId']!));
route('putConfig', 'PUT', 'api/clients/{clientId}/config', async (req) => h.putConfig(req.params['clientId']!, await body(req)));
route('getDiscussion', 'GET', 'api/clients/{clientId}/qbr/{period}/discussion', (req) => h.getDiscussion(req.params['clientId']!, req.params['period']!));
route('putDiscussion', 'PUT', 'api/clients/{clientId}/qbr/{period}/discussion', async (req) => h.putDiscussion(req.params['clientId']!, req.params['period']!, await body(req)));

// Live pipeline + workflow
route('syncQbr', 'POST', 'api/clients/{clientId}/qbr/{period}/sync', (req) => h.syncQbr(req.params['clientId']!, req.params['period']!));
route('putStatus', 'PUT', 'api/clients/{clientId}/qbr/{period}/status', async (req) => h.putStatus(req.params['clientId']!, req.params['period']!, ((await body(req))['status'] as QbrStatus) ?? 'draft'));
route('putSchedule', 'PUT', 'api/clients/{clientId}/qbr/{period}/schedule', async (req) => h.putSchedule(req.params['clientId']!, req.params['period']!, (await body(req)) as { scheduledAt?: string; joinUrl?: string }));
route('pushAction', 'POST', 'api/clients/{clientId}/qbr/{period}/actions/push', async (req) => h.pushQbrAction(req.params['clientId']!, req.params['period']!, (await body(req)) as { actionId?: string; target: PushInput['target'] }));

// Integrations
route('listIntegrations', 'GET', 'api/integrations', () => h.listIntegrations());
route('createIntegration', 'POST', 'api/integrations', async (req) => h.saveIntegration((await body(req)) as unknown as ConnectionInput));
route('updateIntegration', 'PUT', 'api/integrations/{id}', async (req) => h.saveIntegration({ ...((await body(req)) as unknown as ConnectionInput), id: req.params['id']! }));
route('deleteIntegration', 'DELETE', 'api/integrations/{id}', (req) => h.deleteIntegration(req.params['id']!));
route('testIntegration', 'POST', 'api/integrations/{id}/test', (req) => h.testIntegration(req.params['id']!));

route('currentPeriod', 'GET', 'api/period/current', () => h.currentPeriod());
