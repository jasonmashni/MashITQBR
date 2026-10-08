import { describe, expect, it } from 'vitest';
import { conversationItem, needsHipaaRewrite, pendingConversations, reportBlocked } from '../src/pages/workspace/conversations.js';
import type { DiscussionItem, SuggestedConversation } from '../src/types.js';

const conv = (ref: string, topic = `topic ${ref}`): SuggestedConversation => ({ topic, source: 'halo_ticket', ref, when: '2026-08-04' });

describe('pendingConversations', () => {
  it('hides suggestions already on the agenda by sourceRef', () => {
    const agenda: DiscussionItem[] = [
      { id: 'a', topic: 'x', source: 'suggested', sourceRef: 'ticket:1' },
      { id: 'b', topic: 'topic ticket:2' },
    ];
    expect(pendingConversations([conv('ticket:1'), conv('ticket:2'), conv('note:3')], agenda).map((c) => c.ref)).toEqual(['ticket:2', 'note:3']);
  });
});

describe('conversationItem', () => {
  it('builds a planned, suggested agenda item that lands on the report', () => {
    expect(conversationItem(conv('ticket:1', 'New hire'), false, 'id1')).toEqual({
      id: 'id1',
      topic: 'New hire',
      status: 'planned',
      includeInReport: true,
      disposition: 'pending',
      source: 'suggested',
      sourceRef: 'ticket:1',
      sourceTopic: 'New hire',
    });
  });

  it('keeps HIPAA items off the report and carries no Halo detail', () => {
    const item = conversationItem({ ...conv('note:9', 'Call with Anne'), detail: 'Patient details' }, true, 'id2');
    expect(item.includeInReport).toBe(false);
    expect(item.response).toBeUndefined();
    expect(JSON.stringify(item)).not.toContain('Patient');
  });
});

describe('needsHipaaRewrite / reportBlocked', () => {
  it('flags suggested, Halo and email items for HIPAA clients until the topic is rewritten', () => {
    expect(needsHipaaRewrite({ id: 'a', topic: 't', source: 'suggested', sourceTopic: 't' }, true)).toBe(true);
    expect(needsHipaaRewrite({ id: 'a', topic: 't', source: 'halo' }, true)).toBe(true);
    expect(needsHipaaRewrite({ id: 'a', topic: 't', source: 'email', sourceTopic: 't' }, true)).toBe(true);
    expect(needsHipaaRewrite({ id: 'a', topic: 'Rewritten', source: 'email', sourceTopic: 't' }, true)).toBe(false);
    expect(needsHipaaRewrite({ id: 'a', topic: 't' }, true)).toBe(false);
    expect(needsHipaaRewrite({ id: 'a', topic: 't', source: 'suggested', sourceTopic: 't' }, false)).toBe(false);
  });

  it('blocks the On report toggle only while the topic equals the recorded source topic', () => {
    expect(reportBlocked({ id: 'a', topic: ' t ', source: 'email', sourceTopic: 't' }, true)).toBe(true);
    expect(reportBlocked({ id: 'a', topic: 'New words', source: 'email', sourceTopic: 't' }, true)).toBe(false);
    expect(reportBlocked({ id: 'a', topic: 't', source: 'halo' }, true)).toBe(false);
    expect(reportBlocked({ id: 'a', topic: 't', source: 'halo', sourceTopic: 't' }, false)).toBe(false);
  });
});
