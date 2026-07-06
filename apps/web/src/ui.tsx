// Small shared UI helpers used across pages.
import { Badge } from '@mantine/core';
import type { Rating } from './types.js';

export const uid = () => Math.random().toString(36).slice(2, 9);

const RATING_COLOR: Record<Rating, string> = {
  green: 'green',
  amber: 'yellow',
  red: 'red',
  unknown: 'gray',
};

export function RatingBadge({ rating, score }: { rating: Rating; score?: number | null }) {
  return (
    <Badge color={RATING_COLOR[rating] ?? 'gray'} variant="filled" radius="sm">
      {score === undefined ? rating : `${score ?? '—'} / 100 · ${rating}`}
    </Badge>
  );
}

const STATUS_COLOR: Record<string, string> = {
  draft: 'gray',
  data_synced: 'blue',
  narrative_approved: 'indigo',
  scheduled: 'grape',
  completed: 'green',
  dispositioned: 'cyan',
  actions_pushed: 'green',
  archived: 'dark',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge color={STATUS_COLOR[status] ?? 'gray'} variant="light" radius="sm">
      {status.replace(/_/g, ' ')}
    </Badge>
  );
}
