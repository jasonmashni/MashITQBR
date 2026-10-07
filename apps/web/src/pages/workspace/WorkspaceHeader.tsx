import { Title, Group, Button, Select, Badge, Tooltip, Text, Box } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import type { reportUrls } from '../../api.js';
import type { QbrResponse } from '../../types.js';
import { RatingBadge, StatusBadge } from '../../ui.js';
import { DeliverMenu } from './DeliverMenu.js';
import type { Guard, Step } from './nextStep.js';

/**
 * The workspace header: who, which quarter, where the quarter stands, and one
 * primary button for the next step. Everything else is secondary.
 */
export function WorkspaceHeader({
  name,
  qbr,
  periods,
  period,
  onPeriodChange,
  syncing,
  onSync,
  urls,
  clientId,
  next,
  guard,
  primaryBusy,
  onPrimary,
  onPackageSent,
}: {
  name: string;
  qbr: QbrResponse | null;
  periods: Array<{ value: string; label: string }>;
  period: string;
  onPeriodChange: (p: string) => void;
  syncing: boolean;
  onSync: () => void;
  urls: ReturnType<typeof reportUrls>;
  clientId: string;
  next: Step | undefined;
  guard: Guard;
  primaryBusy: boolean;
  onPrimary: (step: Step) => void;
  onPackageSent: () => void;
}) {
  const meta = qbr?.meta;
  const overall = qbr?.model.scorecard.overall;
  const primaryIsSync = next?.key === 'sync';
  const primaryIsSend = next?.key === 'send';

  return (
    <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
      <Box>
        <Title order={2}>{name}</Title>
        <Group gap="xs" mt={6} wrap="wrap">
          {meta && <StatusBadge status={meta.status} />}
          {meta?.meetingSkipped && (
            <Tooltip label={meta.meetingSkipped.reason ?? 'The client opted to skip the review meeting this quarter.'}>
              <Badge color="slate">Meeting skipped</Badge>
            </Tooltip>
          )}
          {overall && <RatingBadge rating={overall.rating} score={overall.score} confidence={overall.confidence} />}
          {qbr && !qbr.verification && (
            <Tooltip label="A figure in the narrative does not trace back to the data. Edit it or regenerate before sending anything.">
              <Badge color="act">Figures unverified</Badge>
            </Tooltip>
          )}
          {next ? (
            <Text size="sm" c="dimmed">Next: {next.label.toLowerCase()}</Text>
          ) : (
            meta && <Text size="sm" c="good.8">All done for {period}</Text>
          )}
        </Group>
      </Box>
      <Group gap="xs" wrap="wrap">
        <Select
          w={170}
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
        {!primaryIsSync && (
          <Tooltip label="Pull fresh data from the connected tools">
            <Button variant="default" leftSection={<IconRefresh size={16} />} loading={syncing} onClick={onSync} disabled={!period}>
              Sync
            </Button>
          </Tooltip>
        )}
        {next && !primaryIsSend && (
          <Button loading={primaryIsSync ? syncing : primaryBusy} onClick={() => onPrimary(next)} disabled={!period}>
            {next.action}
          </Button>
        )}
        <DeliverMenu urls={urls} guard={guard} clientId={clientId} period={period} primary={primaryIsSend} onPackageSent={onPackageSent} />
      </Group>
    </Group>
  );
}
