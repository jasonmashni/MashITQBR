// Small shared UI helpers used across pages: the rating and status words,
// the one confirm dialog, and the uid helper.
import type { ReactNode } from 'react';
import { Badge, Button, Group, Modal, Text } from '@mantine/core';
import { isQbrStatus, qbrStatusLabel, type QbrStatus } from '@mashit/core';
import type { Rating } from './types.js';

export const uid = () => Math.random().toString(36).slice(2, 9);

export type Confidence = 'low' | 'medium' | 'high';

/** Theme color key for a rating; "unknown" is slate, never a traffic-light color. */
export function ratingColorKey(rating: Rating): 'good' | 'watch' | 'act' | 'slate' {
  return rating === 'green' ? 'good' : rating === 'amber' ? 'watch' : rating === 'red' ? 'act' : 'slate';
}

/** Plain word for a rating, shown beside its color so color is never the only signal. */
export function ratingWord(rating: Rating): string {
  return rating === 'green' ? 'Strong' : rating === 'amber' ? 'Watch' : rating === 'red' ? 'Act' : 'Not measured';
}

/**
 * The maturity badge: a number and a word, or "Not scored" when confidence is
 * low. Never clips: the badge grows with its text.
 */
export function RatingBadge({
  rating,
  score,
  confidence,
  size = 'md',
}: {
  rating: Rating;
  score?: number | null;
  confidence?: Confidence;
  size?: 'sm' | 'md' | 'lg';
}) {
  if (score === null || confidence === 'low' || rating === 'unknown') {
    return (
      <Badge color="slate" variant="light" size={size} style={{ whiteSpace: 'nowrap', height: 'auto' }}>
        Not scored
      </Badge>
    );
  }
  const label = score === undefined ? ratingWord(rating) : `${Math.round(score)} ${ratingWord(rating)}${confidence === 'medium' ? ', provisional' : ''}`;
  return (
    <Badge color={ratingColorKey(rating)} variant="light" size={size} style={{ whiteSpace: 'nowrap', height: 'auto' }}>
      {label}
    </Badge>
  );
}

const STATUS_COLOR: Record<QbrStatus, string> = {
  draft: 'slate',
  data_synced: 'brand',
  narrative_approved: 'brand',
  scheduled: 'navy',
  completed: 'good',
  dispositioned: 'good',
  actions_pushed: 'good',
  archived: 'slate',
};

/** Human label for a lifecycle status; an unrecognized value is shown as-is so bad data stays visible. */
export function StatusBadge({ status, size = 'md' }: { status: string; size?: 'sm' | 'md' | 'lg' }) {
  if (!isQbrStatus(status)) {
    return (
      <Badge color="slate" variant="outline" size={size} style={{ whiteSpace: 'nowrap', height: 'auto' }}>
        {status || 'Not started'}
      </Badge>
    );
  }
  return (
    <Badge color={STATUS_COLOR[status]} variant="light" size={size} style={{ whiteSpace: 'nowrap', height: 'auto' }}>
      {qbrStatusLabel(status)}
    </Badge>
  );
}

/**
 * The one confirm dialog. The title says what will happen, the body says what
 * it costs, and the confirm button repeats the verb so the toast can too.
 */
export function ConfirmModal({
  opened,
  title,
  children,
  confirmLabel,
  color = 'brand',
  loading = false,
  disabled = false,
  onConfirm,
  onCancel,
}: {
  opened: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  color?: string;
  loading?: boolean;
  disabled?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  return (
    <Modal opened={opened} onClose={onCancel} title={<Text fw={600}>{title}</Text>} centered radius="md">
      <div>{children}</div>
      <Group justify="flex-end" mt="lg" gap="xs">
        <Button variant="default" onClick={onCancel} disabled={loading}>
          Cancel
        </Button>
        <Button color={color} loading={loading} disabled={disabled} onClick={() => void onConfirm()}>
          {confirmLabel}
        </Button>
      </Group>
    </Modal>
  );
}
