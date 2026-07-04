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
  if (!res.ok || !token) {
    // Entra's error_description says exactly what's wrong (bad secret, wrong
    // tenant, unknown app) — first line only, it can run to paragraphs.
    const desc =
      typeof json['error_description'] === 'string'
        ? json['error_description'].split(/\r?\n/)[0]
        : typeof json['error'] === 'string'
          ? json['error']
          : '';
    throw new Error(`Report-inbox token exchange failed (${res.status})${desc ? `: ${desc}` : ''} — check REPORTS_TENANT_ID / REPORTS_CLIENT_ID / REPORTS_CLIENT_SECRET.`);
  }
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
  /**
   * Per-folder stats so "0 processed" is diagnosable at a glance: mail that
   * was already marked read, or mail that landed in Junk (plus-addressed
   * external mail often does).
   */
  folders?: Array<{ folder: string; total: number; unread: number }>;
}

const POLL_FOLDERS = ['inbox', 'junkemail'] as const;

/**
 * One poll pass: read unread messages (Inbox AND Junk — vendor reports to a
 * plus-address get flagged surprisingly often), route each by its
 * plus-address, file the attachments as documents, mark the message read.
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
  const asNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  const clients = await store.listClients();
  let processed = 0;
  let filed = 0;
  let unrouted = 0;
  const folders: Array<{ folder: string; total: number; unread: number }> = [];
  const messages: InboxMessage[] = [];

  for (const folder of POLL_FOLDERS) {
    // Folder counts are best-effort but make the Settings card honest.
    try {
      const infoRes = await fetchFn(`${mbx}/mailFolders/${folder}`, { headers });
      if (infoRes.ok) {
        const info = (await infoRes.json()) as Json;
        folders.push({ folder, total: asNum(info['totalItemCount']), unread: asNum(info['unreadItemCount']) });
      }
    } catch {
      // stats only
    }

    const listRes = await fetchFn(
      `${mbx}/mailFolders/${folder}/messages?$filter=isRead eq false&$top=25&$select=id,subject,hasAttachments,toRecipients,ccRecipients`,
      { headers },
    );
    if (!listRes.ok) {
      if (folder !== 'inbox') continue; // junk access is optional
      const body = (await listRes.json().catch(() => ({}))) as Json;
      const graphMsg = ((body['error'] as Json | undefined)?.['message'] ?? '') as string;
      throw new Error(
        `Report inbox read failed (${listRes.status})${graphMsg ? `: ${graphMsg}` : ''} — check the Mail.ReadWrite APPLICATION permission (admin-consented) and that REPORTS_MAILBOX is the shared mailbox's exact address.`,
      );
    }
    messages.push(...((((await listRes.json()) as Json)['value'] ?? []) as InboxMessage[]));
  }
  processed = messages.length;

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
      // Skip signature clutter: inline images and tiny image files (Outlook
      // logos/social icons) are not reports.
      if (att['isInline'] === true) continue;
      const name = typeof att['name'] === 'string' ? (att['name'] as string) : 'report';
      const contentType = typeof att['contentType'] === 'string' ? (att['contentType'] as string) : '';
      const contentBytes = typeof att['contentBytes'] === 'string' ? (att['contentBytes'] as string) : '';
      if (!contentBytes) continue;
      const bytes = Buffer.from(contentBytes, 'base64');
      if ((contentType.startsWith('image/') || /\.(png|gif|jpe?g|bmp|ico)$/i.test(name)) && bytes.length < 100 * 1024) continue;
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

  return { processed, filed, unrouted, folders };
}
