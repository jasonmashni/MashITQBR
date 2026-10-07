import type { DiscussionItem, SuggestedConversation } from '../../types.js';

/** Suggestions not yet on the agenda (matched by the item's sourceRef). */
export function pendingConversations(items: SuggestedConversation[], agenda: DiscussionItem[]): SuggestedConversation[] {
  const onAgenda = new Set(agenda.map((it) => it.sourceRef).filter((r): r is string => !!r));
  return items.filter((c) => !onAgenda.has(c.ref));
}

/**
 * The agenda item a suggestion becomes: planned, pending, `source: 'suggested'`.
 * Only the topic is carried over; for a HIPAA client it stays off the report.
 */
export function conversationItem(c: SuggestedConversation, hipaa: boolean, id: string): DiscussionItem {
  return {
    id,
    topic: c.topic,
    status: 'planned',
    includeInReport: !hipaa,
    disposition: 'pending',
    source: 'suggested',
    sourceRef: c.ref,
  };
}

/** A Halo-sourced item on a HIPAA client's agenda: the author should rewrite the topic before it goes on the report. */
export function needsHipaaRewrite(item: DiscussionItem, hipaa: boolean): boolean {
  return hipaa && (item.source === 'suggested' || item.source === 'halo');
}
