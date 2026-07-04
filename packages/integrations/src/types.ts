import type { IntegrationId, MetricCategory, MetricValue, Period } from '@mashit/core';

/** Context handed to a collector for one client/period pull. */
export interface CollectorContext {
  clientId: string;
  period: Period;
  /** This client's external id within the integration (e.g. Halo client id). */
  externalRef?: string;
}

/** The normalized result of a collection: metrics plus any coverage warnings. */
export interface CollectResult {
  source: IntegrationId;
  metrics: MetricValue[];
  /** Human-readable notes about data that couldn't be collected (gaps, manual entry needed). */
  warnings: string[];
  /** Vendor-generated report files the sync should fetch and attach to the QBR. */
  documents?: Array<{ name: string; url: string }>;
}

/**
 * Transport for MCP-backed integrations (Halo / Ninja / Hudu). The QBR backend
 * reuses the existing MASH MCP server, so collectors call tools by name rather
 * than re-implementing each vendor's auth and HTTP client.
 */
export interface McpTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  json: unknown;
}

/** Transport for direct-HTTP integrations (Huntress, Check Point, …). */
export interface HttpTransport {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/** Small builder so collectors can emit metrics tersely and consistently. */
export function metric(
  key: string,
  label: string,
  value: MetricValue['value'],
  o: {
    unit?: string;
    category: MetricCategory;
    source: IntegrationId;
    higherIsBetter?: boolean;
    details?: Array<Record<string, string | number>>;
  },
): MetricValue {
  return { key, label, value, unit: o.unit, category: o.category, source: o.source, higherIsBetter: o.higherIsBetter, details: o.details };
}
