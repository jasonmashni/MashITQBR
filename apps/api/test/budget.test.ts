import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client, MetricSnapshot, MetricValue } from '@mashit/core';
import type { BudgetPlanRecord, DataStore } from '../src/store/index.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-budget-'));
  process.env['QBR_DATA_DIR'] = dir;
  delete process.env['AzureWebJobsStorage'];
});
afterAll(() => {
  delete process.env['QBR_DATA_DIR'];
  rmSync(dir, { recursive: true, force: true });
});

const client: Client = { id: 'acme', name: 'Acme Manufacturing', industry: 'Manufacturing', complianceStandard: 'CMMC', fiscalYearStartMonth: 1 };

const m = (key: string, label: string, value: number): MetricValue => ({ key, label, value, source: 'halo', category: 'spend' });

/** A quarter with $16,380 of recurring managed services and `variable` of other work. */
function snapshot(period: string, variable: number, extra: MetricValue[] = []): MetricSnapshot {
  return {
    clientId: 'acme',
    period,
    capturedAt: '2026-10-01T00:00:00Z',
    metrics: [
      m('finance.mrr', 'Monthly recurring', 5460),
      m('finance.quarter_invoiced', 'Invoiced this quarter', 16380 + variable),
      m('finance.invoiced.managed_services', 'Managed Services', 16380),
      m('finance.invoiced.remote_support', 'Remote Support', variable),
      m('finance.recurring.managed_services', 'Managed Services (monthly)', 5460),
      ...extra,
    ],
  };
}

async function store(): Promise<DataStore> {
  return (await import('../src/store/index.js')).getDataStore();
}

async function seed(): Promise<void> {
  const s = await store();
  await s.upsertClient(client);
  await s.putSnapshot(snapshot('2025-Q4', 2000));
  await s.putSnapshot(snapshot('2026-Q1', 3400));
  await s.putSnapshot(snapshot('2026-Q2', 2100));
  await s.putSnapshot(
    snapshot('2026-Q3', 4000, [
      { ...m('licenses.total', 'Paid license seats', 32), source: 'cipp' },
      { ...m('licenses.assigned', 'Licenses assigned', 31), source: 'cipp' },
      m('finance.recurring.microsoft_365_business_premium', 'Microsoft 365 Business Premium (monthly)', 1108.8),
      m('finance.recurring.managed_end_user', 'Managed End User (monthly)', 5115),
      { ...m('assets.warranty_expired', 'Devices out of warranty', 10), source: 'ninja', category: 'infrastructure' },
      { ...m('assets.warranty_expiring_6mo', 'Warranties expiring < 6mo', 5), source: 'ninja', category: 'infrastructure' },
    ]),
  );
  const now = '2026-10-01T00:00:00Z';
  await s.putOpportunity({ id: 'o1', clientId: 'acme', title: 'SSO rollout', status: 'approved', value: 9000, valueKind: 'one_time', createdAt: now, updatedAt: now });
  await s.putOpportunity({ id: 'o2', clientId: 'acme', title: 'ERP cutover support', status: 'discussing', value: 9000, valueKind: 'one_time', createdAt: now, updatedAt: now });
  await s.putOpportunity({ id: 'o3', clientId: 'acme', title: 'Managed SOC', status: 'idea', value: 800, valueKind: 'recurring', createdAt: now, updatedAt: now });
  await s.putOpportunity({ id: 'o4', clientId: 'acme', title: 'Old idea', status: 'closed', value: 50000, valueKind: 'one_time', createdAt: now, updatedAt: now });
}

const answers = {
  headcountChange: 2,
  copilotSeats: 10,
  copilotSeatPrice: 30,
  workstationUnitCost: 1650,
  refreshPolicy: 'at_warranty_end',
  appetite: 'balanced',
};

const triple = (plan: BudgetPlanRecord, category: string) => {
  const l = plan.lines.find((x) => x.category === category)!;
  return [l.low, l.expected, l.high];
};

describe('budget API', () => {
  beforeAll(seed);

  it('404s for a plan that does not exist and 400s for a bad fiscal year', async () => {
    const b = await import('../src/budget.js');
    expect((await b.getBudget('acme', '2027')).status).toBe(404);
    expect((await b.putBudget('acme', 'next', { answers })).status).toBe(400);
    expect((await b.putBudget('nope', '2027', { answers })).status).toBe(404);
    expect((await b.putBudget('acme', '2027', {})).status).toBe(400);
  });

  it('putBudget saves sanitized answers, assumptions and movers, and audits', async () => {
    const b = await import('../src/budget.js');
    const res = await b.putBudget('acme', '2027', {
      answers: { ...answers, appetite: 'reckless', newLocations: 7, notes: 'Owner wants a lean year' },
      assumptions: ['Two hires in the first half', '  '],
      movers: ['A second site would add about $20,000'],
    });
    expect(res.status).toBe(200);
    const plan = (res.json as { plan: BudgetPlanRecord }).plan;
    expect(plan.status).toBe('draft');
    expect(plan.answers.headcountChange).toBe(2);
    expect(plan.answers.appetite).toBeUndefined();
    expect(plan.answers.newLocations).toBeUndefined();
    expect(plan.answers.notes).toBe('Owner wants a lean year');
    expect(plan.assumptions).toEqual(['Two hires in the first half']);
    expect(plan.movers).toHaveLength(1);
    const audit = await (await store()).listAudit(10);
    expect(audit.some((a) => a.action === 'budget.save' && a.target === 'client:acme')).toBe(true);
    // A second save keeps fields it does not mention.
    const again = await b.putBudget('acme', '2027', { answers });
    expect((again.json as { plan: BudgetPlanRecord }).plan.assumptions).toEqual(['Two hires in the first half']);
  });

  it('recomputeBudget builds the outlook from the latest snapshot, trailing quarters and the board', async () => {
    const b = await import('../src/budget.js');
    const res = await b.recomputeBudget('acme', '2027');
    expect(res.status).toBe(200);
    const plan = (res.json as { plan: BudgetPlanRecord }).plan;
    expect(triple(plan, 'managed_services')).toEqual([65520, 65520, 69480]);
    expect(triple(plan, 'licensing')).toEqual([13306, 14137, 17737]);
    expect(triple(plan, 'hardware')).toEqual([21038, 24750, 28463]);
    expect(triple(plan, 'support_hours')).toEqual([8000, 11500, 16000]);
    // One-time board items only; recurring and closed ones stay out.
    expect(triple(plan, 'projects')).toEqual([18000, 18000, 18000]);
    expect(plan.totals.expected).toBe(plan.lines.reduce((s, l) => s + l.expected, 0));
    expect(plan.caveats).toEqual([]);
    const stored = await (await store()).getBudgetPlan('acme', 2027);
    expect(stored?.lines).toHaveLength(7);
    const audit = await (await store()).listAudit(20);
    expect(audit.some((a) => a.action === 'budget.outlook')).toBe(true);
  });

  it('lists plans with the known facts for the planner', async () => {
    const b = await import('../src/budget.js');
    const res = await b.listBudgets('acme');
    expect(res.status).toBe(200);
    const body = res.json as { plans: BudgetPlanRecord[]; fiscalYearStartMonth: number; known: Array<{ text: string; source: string }> };
    expect(body.plans.map((p) => p.fiscalLabel)).toEqual([2027]);
    expect(body.fiscalYearStartMonth).toBe(1);
    expect(body.known.some((k) => k.text.includes('$5,460') && k.source === 'Halo contracts')).toBe(true);
    expect(body.known.some((k) => k.text.includes('32 paid seats'))).toBe(true);
  });

  it('publishBudget publishes onto the planning period and refuses a locked one', async () => {
    const b = await import('../src/budget.js');
    const s = await store();
    await s.upsertQbr({ clientId: 'acme', period: '2026-Q3', status: 'scheduled', locks: { preread: { at: 'x', by: 'y', version: 1 } }, updatedAt: 'x' });
    const refused = await b.publishBudget('acme', '2027');
    expect(refused).toEqual({ status: 409, json: { error: 'locked', stage: 'preread' } });
    expect((await s.getBudgetPlan('acme', 2027))?.status).toBe('draft');

    await s.upsertQbr({ clientId: 'acme', period: '2026-Q3', status: 'data_synced', updatedAt: 'x' });
    const res = await b.publishBudget('acme', '2027');
    expect(res.status).toBe(200);
    const plan = (res.json as { plan: BudgetPlanRecord }).plan;
    expect(plan.status).toBe('published');
    expect(plan.publishedPeriod).toBe('2026-Q3');
    expect(plan.publishedAt).toBeTruthy();
    const audit = await s.listAudit(30);
    expect(audit.some((a) => a.action === 'budget.publish' && a.detail?.includes('2026-Q3'))).toBe(true);
  });

  it('refuses to publish a plan with no outlook yet', async () => {
    const b = await import('../src/budget.js');
    await b.putBudget('acme', '2028', { answers });
    expect((await b.publishBudget('acme', '2028')).status).toBe(400);
  });

  it('uses the client fiscal start month for the planning period', async () => {
    const b = await import('../src/budget.js');
    const s = await store();
    await s.upsertClient({ id: 'julyco', name: 'July Co', fiscalYearStartMonth: 7 });
    await b.putBudget('julyco', '2027', { answers });
    await b.recomputeBudget('julyco', '2027');
    const res = await b.publishBudget('julyco', '2027');
    expect((res.json as { plan: BudgetPlanRecord }).plan.publishedPeriod).toBe('2026-Q1');
  });
});

describe('budget industry context (internal only)', () => {
  const items = [
    { title: 'Manufacturers spend about 2 to 3 percent of revenue on IT', insight: 'Survey benchmark.', askClient: 'Do you want a revenue comparison?', sourceName: 'Survey', sourceUrl: 'https://example.com/a' },
    { title: 'CMMC assessment windows are tightening', insight: 'Contract clauses are arriving.', askClient: 'When is your next assessment due?' },
  ];

  it('stores the researcher items on the plan and returns them from getBudget', async () => {
    const b = await import('../src/budget.js');
    let seen: Record<string, unknown> | undefined;
    const res = await b.contextBudget('acme', '2027', async (input) => {
      seen = input as unknown as Record<string, unknown>;
      return { items, sourced: true };
    });
    expect(res.status).toBe(200);
    expect(seen).toMatchObject({ industry: 'Manufacturing', complianceStandard: 'CMMC', fiscalLabel: 2027, headcountBand: '26 to 50' });
    const plan = (res.json as { plan: BudgetPlanRecord }).plan;
    expect(plan.context?.items).toHaveLength(2);
    expect(plan.context?.sourced).toBe(true);
    expect(plan.context?.researchedAt).toBeTruthy();
    const got = await b.getBudget('acme', '2027');
    expect((got.json as { plan: BudgetPlanRecord }).plan.context?.items[0]!.title).toBe(items[0]!.title);
    const audit = await (await store()).listAudit(50);
    expect(audit.some((a) => a.action === 'budget.context')).toBe(true);
  });

  it('says so when AI is off and no researcher is supplied', async () => {
    const saved = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const b = await import('../src/budget.js');
      const res = await b.contextBudget('acme', '2027');
      expect(res.status).toBe(200);
      expect((res.json as { available: boolean }).available).toBe(false);
    } finally {
      if (saved !== undefined) process.env['ANTHROPIC_API_KEY'] = saved;
    }
  });

  it('never reaches the narrative input or the report model', async () => {
    const { buildQbrReport } = await import('../src/service.js');
    const { loadReportInputs, storeDataSource } = await import('../src/store/index.js');
    const { v4Narrative } = await import('./narrativeFixture.js');
    const s = await store();
    const plan = await s.getBudgetPlan('acme', 2027);
    expect(plan?.status).toBe('published');
    expect(plan?.context?.items.length).toBe(2);
    let messages = '';
    const report = await buildQbrReport(storeDataSource(s), 'acme', '2026-Q3', {
      narrativeModel: async (m) => {
        messages += JSON.stringify(m);
        return v4Narrative();
      },
      ...(await loadReportInputs(s, 'acme', '2026-Q3')),
    });
    expect(messages.length).toBeGreaterThan(0);
    // The published plan's outlook does reach the report; only the context stays out.
    expect(report.model.investment?.outlook?.fiscalLabel).toBe(2027);
    const model = JSON.stringify(report.model);
    for (const item of items) {
      expect(messages).not.toContain(item.title);
      expect(messages).not.toContain(item.askClient);
      expect(model).not.toContain(item.title);
      expect(model).not.toContain(item.askClient);
    }
  });
});

describe('cleanContextItems', () => {
  it('keeps items with a title, insight and question, and drops non-http sources', async () => {
    const { cleanContextItems } = await import('../src/budgetResearch.js');
    const out = cleanContextItems([
      { title: 'A', insight: 'B', askClient: 'C?', sourceUrl: 'javascript:alert(1)' },
      { title: 'No question', insight: 'B' },
      'junk',
    ]);
    expect(out).toEqual([{ title: 'A', insight: 'B', askClient: 'C?', sourceName: undefined, sourceUrl: undefined }]);
  });
});
