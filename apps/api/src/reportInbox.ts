import { periodFor } from '@mashit/core';
import type { DataStore, DocContentStore, DocumentRecord } from './store/index.js';
import { docPath } from './store/index.js';

/**
 * The per-client report inbox: vendor reports (Check Point, NinjaOne
 * "Endpoint Management Report for QBRs", Dropsuite digests, …) get forwarded
 * or scheduled to `{mailbox-local}+{clientId}@{domain}` on ONE shared
 * mailbox, and a timer polls it via Microsoft Graph application permissions,
 * filing every attachment as a QBR document for that client.
 *
 * Routing: the plus-address tag picks the client; a `2026-Q3`-style tag in
 * the subject picks the quarter (defaults to the current one). Processed
 * messages are marked read; unroutable ones are marked read with a category
 * so they're visible in the mailbox but never retried forever.
 *
 * Configuration (app settings):
 *   REPORTS_MAILBOX      shared mailbox address, e.g. qbr-reports@mashit.net
 *   REPORTS_TENANT_ID    Entra tenant id
 *   REPORTS_CLIENT_ID    app registration with Mail.ReadWrite (application)
 *   REPORTS_CLIENT_SECRET  its client secret (use a Key Vault reference)
 * Scope the permission to just this mailbox with an ApplicationAccessPolicy.
 */

export interface InboxConfig {
  mailbox: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/** Read the inbox configuration from app settings (null = feature off). */
export function inboxConfigFromEnv(env: NodeJS.ProcessEnv = process.env): InboxConfig | null {
  const mailbox = env['REPORTS_MAILBOX'];
  const tenantId = env['REPORTS_TENANT_ID'];
  const clientId = env['REPORTS_CLIENT_ID'];
  const clientSecret = env['REPORTS_CLIENT_SECRET'];
  if (!mailbox || !tenantId || !clientId || !clientSecret) return null;
  return { mailbox, tenantId, clientId, clientSecret };
}

/** The forwarding address for one client (plus-addressing on the shared mailbox). */
export function clientInboxAddress(mailbox: string, clientId: string): string {
  const [local, domain] = mailbox.split('@');
  return `${local}+${clientId}@${domain}`;
}

/** Pull the client tag out of a plus-addressed recipient list. */
export function routeClientId(recipients: string[], mailbox: string): string | undefined {
  const [local, domain] = mailbox.toLowerCase().split('@');
  for (const r of recipients) {
    const m = r.toLowerCase().match(/^([^@+]+)\+([^@]+)@(.+)$/);
    if (m && m[1] === local && m[3] === domain) return m[2];
  }
  return undefined;
}

/** A `2026-Q3`-style tag anywhere in the subject picks the quarter. */
export function routePeriod(subject: string, now: Date): string {
  const m = subject.match(/\b(20\d{2}-Q[1-4])\b/);
  return m ? m[1]! : periodFor(now).id;
}

type Json = Record<string, unknown>;
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

let _token: { value: string; expiresAt: number } | undefined;

async function appToken(cfg: InboxConfig, fetchFn: FetchLike): Promise<string> {
  if (_token && _token.expiresAt > Date.now() + 60_000) return _token.value;
  const res = await fetchFn(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Json;
  const token = typeof json['access_token'] === 'string' ? json['access_token'] : '';
  if (!res.ok || !token) throw new Error(`Report-inbox token exchange failed (${res.status})`);
  const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : 3600;
  _token = { value: token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
}

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

interface InboxMessage {
  id: string;
  subject?: string;
  hasAttachments?: boolean;
  toRecipients?: Array<{ emailAddress?: { address?: string } }>;
  ccRecipients?: Array<{ emailAddress?: { address?: string } }>;
}

export interface InboxPollResult {
  processed: number;
  filed: number;
  unrouted: number;
}

/**
 * One poll pass: read unread messages, route each by its plus-address, file
 * the attachments as documents, mark the message read.
 */
export async function pollReportInbox(
  cfg: InboxConfig,
  store: DataStore,
  docs: DocContentStore,
  fetchFn: FetchLike = fetch,
  now: Date = new Date(),
): Promise<InboxPollResult> {
  const token = await appToken(cfg, fetchFn);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const mbx = `${GRAPH}/users/${encodeURIComponent(cfg.mailbox)}`;

  const listRes = await fetchFn(
    `${mbx}/mailFolders/inbox/messages?$filter=isRead eq false&$top=25&$select=id,subject,hasAttachments,toRecipients,ccRecipients`,
    { headers },
  );
  if (!listRes.ok) throw new Error(`Report inbox read failed (${listRes.status}) — check Mail.ReadWrite application permission.`);
  const messages = (((await listRes.json()) as Json)['value'] ?? []) as InboxMessage[];

  const clients = await store.listClients();
  let filed = 0;
  let unrouted = 0;

  for (const msg of messages) {
    const recipients = [...(msg.toRecipients ?? []), ...(msg.ccRecipients ?? [])]
      .map((r) => r.emailAddress?.address ?? '')
      .filter(Boolean);
    const clientTag = routeClientId(recipients, cfg.mailbox);
    const client = clientTag ? clients.find((c) => c.id.toLowerCase() === clientTag.toLowerCase()) : undefined;

    if (!client || !msg.hasAttachments) {
      unrouted++;
      // Mark read + categorize so it surfaces in the mailbox without looping.
      await fetchFn(`${mbx}/messages/${msg.id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ isRead: true, categories: [client ? 'QBR: no attachments' : 'QBR: unrouted'] }),
      }).catch(() => undefined);
      continue;
    }

    const period = routePeriod(msg.subject ?? '', now);
    const attRes = await fetchFn(`${mbx}/messages/${msg.id}/attachments?$top=20`, { headers });
    const attachments = attRes.ok ? ((((await attRes.json()) as Json)['value'] ?? []) as Json[]) : [];
    for (const att of attachments) {
      if (att['@odata.type'] !== '#microsoft.graph.fileAttachment') continue;
      const name = typeof att['name'] === 'string' ? (att['name'] as string) : 'report';
      const contentBytes = typeof att['contentBytes'] === 'string' ? (att['contentBytes'] as string) : '';
      if (!contentBytes) continue;
      const bytes = Buffer.from(contentBytes, 'base64');
      if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) continue;

      // Same source+name replaces the previous copy (weekly forwards stay tidy).
      const existing = (await store.listDocuments(client.id, period)).find((d) => d.source === 'email' && d.name === name);
      const id = existing?.id ?? Math.random().toString(36).slice(2, 10);
      const record: DocumentRecord = {
        id,
        clientId: client.id,
        period,
        name,
        source: 'email',
        contentType: typeof att['contentType'] === 'string' ? (att['contentType'] as string) : 'application/octet-stream',
        size: bytes.length,
        uploadedAt: now.toISOString(),
        uploadedBy: `inbox:${cfg.mailbox}`,
      };
      await docs.put(docPath(client.id, period, id, name), bytes, record.contentType);
      await store.putDocument(record);
      filed++;
    }

    await fetchFn(`${mbx}/messages/${msg.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isRead: true, categories: ['QBR: filed'] }),
    }).catch(() => undefined);
  }

  return { processed: messages.length, filed, unrouted };
}
