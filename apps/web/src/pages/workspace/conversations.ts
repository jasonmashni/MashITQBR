import { HIPAA_REWRITE_SOURCES, hipaaTopicUnrewritten } from '@mashit/core';
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
    sourceTopic: c.topic,
  };
}

/**
 * A suggested, Halo or email item on a HIPAA client's agenda that still reads
 * as it arrived (or has no recorded source topic): show the rewrite hint.
 */
export function needsHipaaRewrite(item: DiscussionItem, hipaa: boolean): boolean {
  if (!hipaa || !item.source || !(HIPAA_REWRITE_SOURCES as readonly string[]).includes(item.source)) return false;
  return item.sourceTopic === undefined || hipaaTopicUnrewritten(item, hipaa);
}

/** The On report toggle is off and disabled until the topic differs from the source topic (the server enforces it too). */
export function reportBlocked(item: DiscussionItem, hipaa: boolean): boolean {
  return hipaaTopicUnrewritten(item, hipaa);
}
