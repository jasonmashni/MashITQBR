import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DiscussionItem, QbrDiscussion, ReportConfig } from '@mashit/core';

/**
 * Local JSON-file store for per-client report config (branding + sections) and
 * per-QBR discussion/notes. This is the v1 persistence seam — in Azure this is
 * replaced by Azure SQL (config/discussion) + Blob (uploaded logos). The store
 * interface (get/put + loadReportInputs) stays the same when swapped.
 */
interface StoreShape {
  configs: Record<string, ReportConfig>;
  discussions: Record<string, QbrDiscussion>; // key: `${clientId}:${period}`
}

const DIR = process.env['QBR_DATA_DIR'] ?? resolve(process.cwd(), '.data');
const FILE = resolve(DIR, 'store.json');

function read(): StoreShape {
  if (!existsSync(FILE)) return { configs: {}, discussions: {} };
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<StoreShape>;
    return { configs: parsed.configs ?? {}, discussions: parsed.discussions ?? {} };
  } catch {
    return { configs: {}, discussions: {} };
  }
}

function write(s: StoreShape): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(s, null, 2), 'utf8');
}

const key = (clientId: string, period: string) => `${clientId}:${period}`;

export function getConfig(clientId: string): ReportConfig | undefined {
  return read().configs[clientId];
}

export function putConfig(config: ReportConfig): ReportConfig {
  const s = read();
  s.configs[config.clientId] = config;
  write(s);
  return config;
}

export function getDiscussion(clientId: string, period: string): QbrDiscussion | undefined {
  return read().discussions[key(clientId, period)];
}

export function putDiscussion(d: QbrDiscussion): QbrDiscussion {
  const s = read();
  s.discussions[key(d.clientId, d.period)] = d;
  write(s);
  return d;
}

export interface ReportInputs {
  config?: ReportConfig;
  discussion?: DiscussionItem[];
  notes?: string;
}

/** Load the persisted config + discussion to feed a report build. */
export function loadReportInputs(clientId: string, period: string): ReportInputs {
  const s = read();
  const d = s.discussions[key(clientId, period)];
  return { config: s.configs[clientId], discussion: d?.items, notes: d?.notes };
}
