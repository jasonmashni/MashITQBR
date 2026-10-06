import { Title, Group, Button, Select, Badge, Tooltip } from '@mantine/core';
import {
  IconRefresh,
  IconFileText,
  IconFileTypePdf,
  IconPresentation,
  IconMailForward,
} from '@tabler/icons-react';
import type { reportUrls } from '../../api.js';
import type { QbrResponse } from '../../types.js';
import { RatingBadge, StatusBadge } from '../../ui.js';

// ── Workspace header: client name, status badges, quarter picker, deliverables ─
export function WorkspaceHeader({
  name,
  qbr,
  periods,
  period,
  onPeriodChange,
  syncing,
  onSync,
  urls,
}: {
  name: string;
  qbr: QbrResponse | null;
  periods: Array<{ value: string; label: string }>;
  period: string;
  onPeriodChange: (p: string) => void;
  syncing: boolean;
  onSync: () => void;
  urls: ReturnType<typeof reportUrls>;
}) {
  const meta = qbr?.meta;
  return (
    <Group justify="space-between" align="flex-end">
      <div>
        <Title order={2}>{name}</Title>
        <Group gap="xs" mt={4}>
          {meta && <StatusBadge status={meta.status} />}
          {meta?.meetingSkipped && (
            <Tooltip label={meta.meetingSkipped.reason ?? 'The client opted to skip the review meeting this quarter.'}>
              <Badge color="gray" variant="light">meeting skipped</Badge>
            </Tooltip>
          )}
          {qbr && <RatingBadge rating={qbr.model.scorecard.overall.rating} score={qbr.model.scorecard.overall.score} />}
          {qbr && !qbr.verification && <Badge color="red" variant="light">figures unverified</Badge>}
        </Group>
      </div>
      <Group gap="xs">
        <Select
          w={180}
          data={periods}
          value={period || null}
          onChange={(v) => {
            if (!v) return;
            onPeriodChange(v);
          }}
          allowDeselect={false}
          placeholder="Quarter"
          aria-label="Quarter"
        />
        <Button leftSection={<IconRefresh size={16} />} loading={syncing} onClick={onSync} disabled={!period}>Sync</Button>
        <Button component="a" href={urls.html} target="_blank" variant="default" leftSection={<IconFileText size={16} />} disabled={!qbr}>
          Report
        </Button>
        <Button component="a" href={urls.pdf} target="_blank" variant="default" leftSection={<IconFileTypePdf size={16} />} disabled={!qbr}>
          PDF
        </Button>
        <Button component="a" href={urls.deck} download variant="default" leftSection={<IconPresentation size={16} />} disabled={!qbr}>
          Deck
        </Button>
        <Tooltip label="Downloads a ready-to-send Outlook draft: recipient, a short message, and the PDF attached.">
          <Button component="a" href={urls.email} variant="default" leftSection={<IconMailForward size={16} />} disabled={!qbr}>
            Email draft
          </Button>
        </Tooltip>
      </Group>
    </Group>
  );
}
