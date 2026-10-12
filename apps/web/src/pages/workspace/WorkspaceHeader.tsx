import { useState } from 'react';
import { Title, Group, Button, Select, Badge, Tooltip, Text, Box, Menu, ActionIcon, Radio, Stack, Textarea } from '@mantine/core';
import { IconDots, IconLockOpen, IconRefresh } from '@tabler/icons-react';
import type { reportUrls } from '../../api.js';
import type { PackageStage, QbrMeta, QbrResponse } from '../../types.js';
import { ConfirmModal, RatingBadge, StatusBadge } from '../../ui.js';
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
  lockNotice,
  onReopen,
  meta: metaProp,
}: {
  name: string;
  qbr: QbrResponse | null;
  /** The quarter's record when the QBR itself failed to load (lock state from the period list). */
  meta?: QbrMeta;
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
  /** The lock sentence when the quarter is locked (disables Sync, offers Reopen). */
  lockNotice?: string;
  onReopen: (stage: PackageStage, reason: string) => Promise<void>;
}) {
  const meta = qbr?.meta ?? metaProp;
  const locks = meta?.locks;
  const locked = Boolean(lockNotice);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenStage, setReopenStage] = useState<PackageStage>('final');
  const [reopenReason, setReopenReason] = useState('');
  const [reopening, setReopening] = useState(false);
  const openReopen = () => {
    setReopenStage(locks?.final ? 'final' : 'preread');
    setReopenReason('');
    setReopenOpen(true);
  };
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
          {locks?.final ? (
            <Badge color="good" variant="light">Final</Badge>
          ) : (
            locks?.preread && <Badge color="navy" variant="light">Pre-read sent</Badge>
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
          <Tooltip label={lockNotice ?? 'Pull fresh data from the connected tools'} multiline w={locked ? 300 : undefined}>
            <Button variant="default" leftSection={<IconRefresh size={16} />} loading={syncing} onClick={onSync} disabled={!period || locked}>
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
        <Menu withinPortal position="bottom-end" width={240} shadow="md">
          <Menu.Target>
            <ActionIcon variant="default" size={36} aria-label="More actions">
              <IconDots size={16} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<IconLockOpen size={16} />} disabled={!locked} onClick={openReopen}>
              <Text size="sm">Reopen quarter</Text>
              <Text size="xs" c="dimmed">{locked ? 'Needs a reason; the reopen is audited.' : 'This quarter is not locked.'}</Text>
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
      <ConfirmModal
        opened={reopenOpen}
        title={`Reopen ${period}?`}
        confirmLabel="Reopen"
        color="act"
        loading={reopening}
        disabled={!reopenReason.trim()}
        onCancel={() => setReopenOpen(false)}
        onConfirm={async () => {
          setReopening(true);
          try {
            await onReopen(reopenStage, reopenReason.trim());
            setReopenOpen(false);
          } catch {
            // The caller shows the error; the dialog stays open.
          } finally {
            setReopening(false);
          }
        }}
      >
        <Stack gap="sm">
          <Radio.Group label="What to reopen" value={reopenStage} onChange={(v) => setReopenStage(v as PackageStage)}>
            <Stack gap={6} mt={6}>
              <Radio value="final" label="Agenda and decisions" disabled={!locks?.final} />
              <Radio value="preread" label="Everything" />
            </Stack>
          </Radio.Group>
          <Textarea
            label="Reason"
            required
            autosize
            minRows={2}
            placeholder="Why this quarter needs to change"
            value={reopenReason}
            onChange={(e) => setReopenReason(e.currentTarget.value)}
          />
          <Text size="xs" c="dimmed">Stored packages are kept. The next lock stores a new version marked as revised.</Text>
        </Stack>
      </ConfirmModal>
    </Group>
  );
}
