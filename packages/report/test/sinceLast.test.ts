import { describe, it, expect } from 'vitest';
import { SEED_CLIENTS, findSeedSnapshot, type DiscussionItem } from '@mashit/core';
import { buildReportModel, conversationStatus } from '@mashit/report';

const anp = SEED_CLIENTS.find((c) => c.id === 'anp')!;
const base = { client: anp, current: findSeedSnapshot('anp', '2026-Q1')!, previous: findSeedSnapshot('anp', '2025-Q4')! };
const item = (over: Partial<DiscussionItem>): DiscussionItem => ({ id: Math.random().toString(36).slice(2), topic: 'Topic', ...over });

describe('conversationStatus', () => {
  it('maps a pushed ticket that is still open to in progress', () => {
    expect(conversationStatus(item({ disposition: 'create_ticket', status: 'discussed', externalRef: { system: 'halo', id: '1', status: 'In Progress' } }))).toBe('in_progress');
  });
  it('maps no action to closed', () => {
    expect(conversationStatus(item({ disposition: 'no_action', status: 'discussed' }))).toBe('closed');
  });
  it('maps a planned item with no response to waiting', () => {
    expect(conversationStatus(item({ status: 'planned' }))).toBe('waiting');
    expect(conversationStatus(item({ status: 'planned', response: '  ' }))).toBe('waiting');
  });
  it('maps a discussed item whose external status is closed, resolved or complete to done', () => {
    for (const status of ['Closed', 'Resolved', 'Completed']) {
      expect(conversationStatus(item({ disposition: 'create_ticket', status: 'discussed', externalRef: { system: 'halo', id: '2', status } }))).toBe('done');
    }
  });
  it('maps anything else to on plan', () => {
    expect(conversationStatus(item({ status: 'discussed', response: 'Agreed' }))).toBe('on_plan');
    expect(conversationStatus(item({ status: 'planned', response: 'James to confirm' }))).toBe('on_plan');
    expect(conversationStatus(item({ disposition: 'create_opportunity', status: 'discussed' }))).toBe('on_plan');
  });
});

describe('sinceLastQuarter', () => {
  it('is empty when the previous quarter had no discussion (first QBR)', () => {
    expect(buildReportModel(base).sinceLastQuarter).toEqual([]);
    expect(buildReportModel({ ...base, previousDiscussion: [] }).sinceLastQuarter).toEqual([]);
  });

  it('takes at most five reportable items in agenda order and shows on plan as in progress', () => {
    const previousDiscussion: DiscussionItem[] = [
      item({ topic: 'Hidden', includeInReport: false, sortOrder: 0 }),
      item({ topic: 'SharePoint sharing', disposition: 'create_ticket', status: 'discussed', externalRef: { system: 'halo', id: '41880', status: 'Closed' }, sortOrder: 1 }),
      item({ topic: 'Studio 5000 access', status: 'planned', sortOrder: 2 }),
      item({ topic: 'SSO rollout', status: 'discussed', response: 'Phase one first', sortOrder: 3 }),
      item({ topic: 'Old PC', disposition: 'no_action', status: 'discussed', sortOrder: 4 }),
      item({ topic: 'Clock-in tablet', disposition: 'create_ticket', status: 'discussed', externalRef: { system: 'halo', id: '41882', status: 'Open' }, sortOrder: 5 }),
      item({ topic: 'Sixth', status: 'discussed', sortOrder: 6 }),
    ];
    const rows = buildReportModel({ ...base, previousDiscussion }).sinceLastQuarter;
    expect(rows.map((r) => [r.topic, r.status])).toEqual([
      ['SharePoint sharing', 'done'],
      ['Studio 5000 access', 'waiting'],
      ['SSO rollout', 'in_progress'],
      ['Old PC', 'closed'],
      ['Clock-in tablet', 'in_progress'],
    ]);
    expect(rows[2]!.detail).toBe('Phase one first');
  });

  it('uses the live Halo status when one was looked up', () => {
    const previousDiscussion = [item({ topic: 'Tablet', disposition: 'create_ticket', status: 'discussed', externalRef: { system: 'halo', id: '41882', status: 'Open' } })];
    const rows = buildReportModel({ ...base, previousDiscussion, ticketStatuses: { '41882': 'Resolved' } }).sinceLastQuarter;
    expect(rows[0]!.status).toBe('done');
  });

  it('is hidden when the client turned it off', () => {
    const previousDiscussion = [item({ topic: 'Anything', status: 'discussed' })];
    expect(buildReportModel({ ...base, previousDiscussion, config: { clientId: 'anp', showSinceLastQuarter: false } }).sinceLastQuarter).toEqual([]);
  });
});

describe('protection rows on the model', () => {
  it('carries the five questions with the narrative prose merged by id', () => {
    const m = buildReportModel({
      ...base,
      narrative: {
        headline: 'h',
        lede: 'l',
        did: [],
        saw: [],
        decisions: [],
        plan: { now: [], next: [], later: [] },
        protection: [{ question: 'recover', inPlace: 'Daily cloud backup.', thisQuarter: 'One lab PC is not backing up.' }],
        figures_referenced: [],
      },
    });
    expect(m.protection.map((r) => r.id)).toEqual(['get_in', 'know', 'recover', 'keep_up', 'run_well']);
    const recover = m.protection.find((r) => r.id === 'recover')!;
    expect(recover.inPlace).toBe('Daily cloud backup.');
    expect(recover.thisQuarter).toBe('One lab PC is not backing up.');
    expect(m.protection.find((r) => r.id === 'get_in')!.inPlace).toBeUndefined();
  });

  it('passes revisedAt through', () => {
    expect(buildReportModel({ ...base, revisedAt: '2026-10-09' }).revisedAt).toBe('2026-10-09');
    expect(buildReportModel(base).revisedAt).toBeUndefined();
  });
});
