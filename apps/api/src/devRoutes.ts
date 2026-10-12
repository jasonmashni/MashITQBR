/**
 * The local dev server's route table: the same routes functions.ts registers
 * on Azure Functions, over the same handlers. A test keeps the two in step.
 */
import * as h from './handlers.js';
import * as budget from './budget.js';
import type { ApiResult } from './handlers.js';
import type { ConnectionInput } from './connections.js';
import type { PushInput } from './actions.js';
import { principalFrom } from './auth.js';
import { suggestedConversations } from './conversations.js';

export type HeaderGet = (name: string) => string | undefined;

export interface Route {
  method: string;
  re: RegExp;
  run: (m: RegExpMatchArray, body: Record<string, unknown>, url: URL, header: HeaderGet) => Promise<ApiResult> | ApiResult;
}

export const routes: Route[] = [
  { method: 'GET', re: /^\/api\/clients$/, run: () => h.listClients() },
  { method: 'POST', re: /^\/api\/clients\/import\/halo$/, run: () => h.importHalo() },
  { method: 'PUT', re: /^\/api\/clients\/([^/]+)\/goals$/, run: (m, b) => h.putClientGoals(m[1]!, b) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/research$/, run: (m) => h.researchClient(m[1]!) },
  { method: 'GET', re: /^\/api\/clients\/([^/]+)$/, run: (m) => h.getClientRecord(m[1]!) },
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
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/documents\/([^/]+)\/match$/, run: (m) => h.matchQbrDocument(m[1]!, m[2]!, m[3]!) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/documents\/([^/]+)\/extract$/, run: (m) => h.extractQbrDocument(m[1]!, m[2]!, m[3]!) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/metrics\/import$/, run: (m, b) => h.importDocumentMetrics(m[1]!, m[2]!, b) },
  { method: 'DELETE', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/metrics\/import$/, run: (m, _b, url) => h.removeImportedMetrics(m[1]!, m[2]!, url.searchParams.get('source') ?? undefined) },
  { method: 'DELETE', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/documents\/([^/]+)$/, run: (m) => h.deleteQbrDocument(m[1]!, m[2]!, m[3]!) },
  { method: 'GET', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/discussion$/, run: (m) => h.getDiscussion(m[1]!, m[2]!) },
  { method: 'PUT', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/discussion$/, run: (m, b) => h.putDiscussion(m[1]!, m[2]!, b) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/agenda$/, run: (m, b) => h.suggestQbrAgenda(m[1]!, m[2]!, undefined, Array.isArray(b['exclude']) ? (b['exclude'] as string[]) : []) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/sync$/, run: (m) => h.syncQbr(m[1]!, m[2]!) },
  { method: 'PUT', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/status$/, run: (m, b) => h.putStatus(m[1]!, m[2]!, b as { status: unknown; force?: unknown; reason?: unknown }) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/narrative\/approve$/, run: (m) => h.approveNarrative(m[1]!, m[2]!) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/disposition$/, run: (m, b) => h.dispositionQbrSkipped(m[1]!, m[2]!, b as { reason?: unknown }) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/package\/sent$/, run: (m) => h.markPackageSent(m[1]!, m[2]!) },
  { method: 'PUT', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/schedule$/, run: (m, b) => h.putSchedule(m[1]!, m[2]!, b as { scheduledAt?: string; joinUrl?: string }) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/actions\/push$/, run: (m, b) => h.pushQbrAction(m[1]!, m[2]!, b as { actionId?: string; target: PushInput['target'] }) },
  { method: 'GET', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/email\.eml$/, run: (m, _b, url, header) => h.getEmailDraft(m[1]!, m[2]!, url.searchParams.get('ai'), header) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/email$/, run: (m, b, _u, header) => h.emailQbr(m[1]!, m[2]!, b as never, header) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/meeting$/, run: (m, b, _u, header) => h.createMeeting(m[1]!, m[2]!, b as never, header) },
  // Workstream B: frozen quarters
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/finalize$/, run: (m) => h.finalizeQbr(m[1]!, m[2]!) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/reopen$/, run: (m, b) => h.reopenQbr(m[1]!, m[2]!, b as { stage?: unknown; reason?: unknown }) },
  // Workstream E: conversations
  { method: 'GET', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/conversations\/suggested$/, run: (m) => suggestedConversations(m[1]!, m[2]!) },
  // Workstream D: budget planning
  { method: 'GET', re: /^\/api\/clients\/([^/]+)\/budget$/, run: (m) => budget.listBudgets(m[1]!) },
  { method: 'GET', re: /^\/api\/clients\/([^/]+)\/budget\/([^/]+)$/, run: (m) => budget.getBudget(m[1]!, m[2]!) },
  { method: 'PUT', re: /^\/api\/clients\/([^/]+)\/budget\/([^/]+)$/, run: (m, b) => budget.putBudget(m[1]!, m[2]!, b) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/budget\/([^/]+)\/outlook$/, run: (m) => budget.recomputeBudget(m[1]!, m[2]!) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/budget\/([^/]+)\/context$/, run: (m) => budget.contextBudget(m[1]!, m[2]!) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/budget\/([^/]+)\/publish$/, run: (m) => budget.publishBudget(m[1]!, m[2]!) },
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
  // Client self-scheduling (public page + its API) and its portal management
  { method: 'GET', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/booking$/, run: (m) => h.getBookingState(m[1]!, m[2]!) },
  { method: 'POST', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/booking$/, run: (m) => h.ensureBookingLink(m[1]!, m[2]!) },
  { method: 'DELETE', re: /^\/api\/clients\/([^/]+)\/qbr\/([^/]+)\/meeting$/, run: (m) => h.cancelQbrMeeting(m[1]!, m[2]!) },
  { method: 'GET', re: /^\/book\/([^/]+)$/, run: (m) => h.getBookingPage(m[1]!) },
  { method: 'GET', re: /^\/api\/book\/([^/]+)$/, run: (m) => h.publicBookingInfo(m[1]!) },
  { method: 'GET', re: /^\/api\/book\/([^/]+)\/slots$/, run: (m, _b, url) => h.publicBookingSlots(m[1]!, url.searchParams.get('from'), url.searchParams.get('to')) },
  { method: 'POST', re: /^\/api\/book\/([^/]+)$/, run: (m, b) => h.publicBook(m[1]!, b) },
  // In-portal notifications
  { method: 'GET', re: /^\/api\/notifications$/, run: (_m, _b, url) => h.getNotifications(url.searchParams.get('limit')) },
  { method: 'POST', re: /^\/api\/notifications\/read$/, run: (_m, b) => h.markNotificationsRead(b) },
];
