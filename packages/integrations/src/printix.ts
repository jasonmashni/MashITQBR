import type { MetricValue } from '@mashit/core';
import { metric, type CollectorContext, type CollectResult, type HttpTransport } from './types.js';
import { toArray } from './util.js';

/**
 * Printix (cloud print management) client. Auth is OAuth2 client_credentials
 * against auth.printix.net; the tenant API lives at api.printix.net. The QBR
 * signal is modest but real: printer fleet size and offline printers.
 */

export interface PrintixCfg {
  /** Printix tenant id (GUID from the Printix admin portal). */
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Override for tests / regional endpoints. */
  authUrl?: string;
  apiUrl?: string;
}

type Json = Record<string, unknown>;

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function printixToken(http: HttpTransport, cfg: PrintixCfg): Promise<string> {
  const key = `${cfg.tenantId}|${cfg.clientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret }).toString();
  const res = await http.request({
    method: 'POST',
    url: cfg.authUrl ?? 'https://auth.printix.net/oauth/token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const json = (res.json ?? {}) as Json;
  const token = typeof json['access_token'] === 'string' ? json['access_token'] : '';
  if (res.status < 200 || res.status >= 300 || !token) throw new Error(`Printix token exchange failed (${res.status})`);
  const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : 3600;
  tokenCache.set(key, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

/** Normalize printer rows into fleet metrics. */
export function normalizePrintixPrinters(rows: Json[]): MetricValue[] {
  const offline = rows.filter((r) => /offline|error/i.test(String(r['status'] ?? r['state'] ?? ''))).length;
  return [
    metric('printix.printers', 'Managed printers', rows.length, { category: 'infrastructure', source: 'printix', unit: 'count' }),
    metric('printix.printers_offline', 'Printers offline', offline, { category: 'infrastructure', source: 'printix', unit: 'count', higherIsBetter: false }),
  ];
}

/** Collect Printix fleet posture for the tenant. */
export async function collectPrintix(ctx: CollectorContext, http: HttpTransport, cfg: PrintixCfg): Promise<CollectResult> {
  const api = (cfg.apiUrl ?? 'https://api.printix.net').replace(/\/+$/, '');
  try {
    const token = await printixToken(http, cfg);
    const res = await http.request({
      method: 'GET',
      url: `${api}/cloudprint/tenants/${encodeURIComponent(cfg.tenantId)}/printers?pageSize=500`,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`Printix responded ${res.status}`);
    // HAL-style embedding is common on Printix responses; unwrap tolerantly.
    const json = res.json as Json | null;
    const embedded = (json?.['_embedded'] as Json | undefined)?.['printers'];
    const rows = Array.isArray(embedded) ? (embedded as Json[]) : toArray<Json>(json, ['printers']);
    return { source: 'printix', metrics: normalizePrintixPrinters(rows), warnings: [] };
  } catch (e) {
    return { source: 'printix', metrics: [], warnings: [`Printix unavailable: ${e instanceof Error ? e.message : 'error'}`] };
  }
}
