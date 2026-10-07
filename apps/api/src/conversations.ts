import { parsePeriod, type Period } from '@mashit/core';
import { FetchHttpTransport, listHaloConversations, type HaloConversation } from '@mashit/integrations';
import { resolveSecret } from './connections.js';
import type { ApiResult } from './handlers.js';
import { directHaloConn, type Integrations } from './integrationsService.js';
import { getDataStore, getSecretStore } from './store/index.js';

/** GET suggested conversations: what the Meeting tab offers to add to the agenda. */
export interface SuggestedConversationsResponse {
  items: HaloConversation[];
  warnings: string[];
}

/**
 * Suggested conversations for one client and quarter, from Halo: requests
 * from the primary contact or flagged VIP, opportunities, CRM notes. This is
 * an internal view, so HIPAA clients get the list too; the Meeting tab adds
 * their items with `includeInReport: false`.
 */
export async function suggestedConversations(clientId: string, period: string, intg?: Integrations): Promise<ApiResult> {
  const store = intg?.store ?? getDataStore();
  let p: Period;
  try {
    p = parsePeriod(period);
  } catch {
    return { status: 400, json: { error: `Invalid period: ${period}` } };
  }
  const client = await store.getClient(clientId);
  if (!client) return { status: 404, json: { error: `Unknown client: ${clientId}` } };

  const empty = (warning: string): ApiResult => ({ status: 200, json: { items: [], warnings: [warning] } satisfies SuggestedConversationsResponse });
  const haloRef = client.integrationRefs?.halo;
  if (!haloRef) return empty('This client is not linked to a Halo client.');
  const conn = await directHaloConn(store);
  if (!conn) return empty('No direct Halo connection is configured.');

  const secrets = intg?.secrets ?? getSecretStore();
  const http = intg?.http ?? new FetchHttpTransport();
  const cfg = {
    baseUrl: conn.config['baseUrl'] ?? '',
    clientId: conn.config['clientId'] ?? '',
    clientSecret: (await resolveSecret(secrets, conn, 'clientSecret')) ?? '',
    tenant: conn.config['tenant'] || undefined,
  };
  try {
    const out = await listHaloConversations(http, cfg, {
      clientId: haloRef,
      start: p.start,
      end: p.end,
      ...(client.primaryContact?.email ? { primaryContactEmail: client.primaryContact.email } : {}),
    });
    return { status: 200, json: out satisfies SuggestedConversationsResponse };
  } catch (e) {
    return { status: 502, json: { error: e instanceof Error ? e.message : 'Halo request failed' } };
  }
}
