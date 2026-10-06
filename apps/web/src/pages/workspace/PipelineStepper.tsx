import { useState } from 'react';
import { Group, Button, Card, Text, Stack, Textarea, Popover, UnstyledButton, Box } from '@mantine/core';
import { IconCalendarOff, IconCheck } from '@tabler/icons-react';
import { ConfirmModal } from '../../ui.js';
import { readyToComplete, type Step } from './nextStep.js';

/**
 * The QBR pipeline at a glance: seven compact steps that wrap on narrow
 * screens, the current one in brand blue, done ones ticked in teal. Clicking
 * a step opens its tab. Closing the quarter asks first.
 */
export function PipelineStepper({
  steps,
  next,
  skipped,
  packageSent,
  period,
  goTab,
  onComplete,
  onSkipMeeting,
}: {
  steps: Step[];
  next: Step | undefined;
  skipped: boolean;
  packageSent: boolean;
  period: string;
  goTab: (tab: string) => void;
  onComplete: () => Promise<void>;
  onSkipMeeting: (reason: string) => void | Promise<void>;
}) {
  const closed = Boolean(steps[steps.length - 1]?.done);
  const ready = readyToComplete(steps);
  // The escape hatch when the client passes on the review: once the package is
  // out, the QBR can be dispositioned as "meeting skipped" and closed without
  // walking the Book / Hold steps.
  const canSkip = !closed && !skipped && packageSent;
  const [skipOpen, setSkipOpen] = useState(false);
  const [skipReason, setSkipReason] = useState('');
  const [skipping, setSkipping] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closing, setClosing] = useState(false);

  return (
    <Card padding="md">
      <Group gap="xs" wrap="wrap" align="stretch">
        {steps.map((s, i) => {
          const state = s.done ? 'done' : s.key === next?.key ? 'current' : 'todo';
          return (
            <UnstyledButton
              key={s.key}
              onClick={() => goTab(s.tab)}
              aria-label={`${s.label}: ${s.desc}`}
              aria-current={state === 'current' ? 'step' : undefined}
              style={{
                borderRadius: 4,
                border: `1px solid ${state === 'current' ? 'var(--qbr-brand, #004aad)' : 'var(--qbr-hairline)'}`,
                background: state === 'done' ? 'var(--mantine-color-good-0)' : state === 'current' ? 'var(--mantine-color-brand-0)' : 'transparent',
                padding: '6px 10px',
                minWidth: 150,
              }}
            >
              <Group gap={8} wrap="nowrap" align="flex-start">
                <Box w={16} mt={2}>
                  {s.done ? (
                    <IconCheck size={15} color="var(--qbr-good)" />
                  ) : (
                    <Text size="xs" fw={600} c={state === 'current' ? 'brand.8' : 'dimmed'} data-num>
                      {i + 1}
                    </Text>
                  )}
                </Box>
                <Box>
                  <Text size="sm" fw={state === 'current' ? 600 : 500} c={state === 'todo' ? 'dimmed' : undefined} lh={1.2}>
                    {s.label}
                  </Text>
                  <Text size="xs" c="dimmed" lh={1.3}>
                    {s.desc}
                  </Text>
                </Box>
              </Group>
            </UnstyledButton>
          );
        })}
      </Group>
      {(ready || canSkip) && (
        <Group justify="flex-end" mt="sm" gap="xs">
          {canSkip && (
            <Popover opened={skipOpen} onChange={setSkipOpen} width={340} position="bottom-end" withArrow shadow="md">
              <Popover.Target>
                <Button size="xs" variant="default" leftSection={<IconCalendarOff size={14} />} onClick={() => setSkipOpen((o) => !o)}>
                  Record a skipped meeting
                </Button>
              </Popover.Target>
              <Popover.Dropdown>
                <Stack gap="xs">
                  <Text size="sm" fw={600}>Close {period} without a meeting</Text>
                  <Text size="xs" c="dimmed">
                    The report package already went out. This records that the client skipped the review and closes the quarter; no meeting date is stored.
                  </Text>
                  <Textarea
                    size="xs"
                    autosize
                    minRows={2}
                    placeholder="Reason (optional), e.g. client declined, happy with the emailed report"
                    value={skipReason}
                    onChange={(e) => setSkipReason(e.currentTarget.value)}
                  />
                  <Group justify="flex-end" gap="xs">
                    <Button size="xs" variant="default" onClick={() => setSkipOpen(false)}>Cancel</Button>
                    <Button
                      size="xs"
                      color="good"
                      loading={skipping}
                      leftSection={<IconCheck size={14} />}
                      onClick={async () => {
                        setSkipping(true);
                        try {
                          await onSkipMeeting(skipReason.trim());
                          setSkipOpen(false);
                          setSkipReason('');
                        } finally {
                          setSkipping(false);
                        }
                      }}
                    >
                      Close the quarter
                    </Button>
                  </Group>
                </Stack>
              </Popover.Dropdown>
            </Popover>
          )}
          {ready && (
            <Button size="xs" color="good" leftSection={<IconCheck size={14} />} onClick={() => setConfirmClose(true)}>
              Close the quarter
            </Button>
          )}
        </Group>
      )}
      <ConfirmModal
        opened={confirmClose}
        title={`Close ${period}?`}
        confirmLabel="Close the quarter"
        color="good"
        loading={closing}
        onCancel={() => setConfirmClose(false)}
        onConfirm={async () => {
          setClosing(true);
          try {
            await onComplete();
            setConfirmClose(false);
          } finally {
            setClosing(false);
          }
        }}
      >
        <Text size="sm">
          This marks the review complete. The workspace will open on the next quarter from now on, and the dashboard will count this client as done for {period}.
        </Text>
        <Text size="sm" c="dimmed" mt="xs">
          Reopening later needs an audited status override.
        </Text>
      </ConfirmModal>
    </Card>
  );
}
