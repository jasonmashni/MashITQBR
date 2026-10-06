import { useState } from 'react';
import {
  Group,
  Button,
  Card,
  Text,
  Stack,
  Textarea,
  Stepper,
  Popover,
} from '@mantine/core';
import { IconCalendarOff, IconCheck } from '@tabler/icons-react';
import type { Discussion, QbrResponse } from '../../types.js';
import { statusAtLeast } from '@mashit/core';

// ── QBR pipeline stepper: the start-to-finish flow at a glance ────────────────
export function PipelineStepper({
  hasData,
  meta,
  unfiled,
  disc,
  goTab,
  onComplete,
  onSkipMeeting,
}: {
  hasData: boolean;
  meta: QbrResponse['meta'] | undefined;
  unfiled: number;
  disc: Discussion | null;
  goTab: (tab: string) => void;
  onComplete: () => void;
  onSkipMeeting: (reason: string) => void | Promise<void>;
}) {
  const scheduled = Boolean(meta?.meeting?.scheduledAt);
  const skipped = Boolean(meta?.meetingSkipped);
  const met =
    (scheduled && new Date(meta!.meeting!.scheduledAt!) < new Date()) ||
    Boolean(disc?.items.some((i) => i.status === 'discussed')) ||
    (statusAtLeast(meta?.status, 'completed') && !skipped);
  const completed = meta?.status === 'completed' || meta?.status === 'archived';
  const steps: Array<{ label: string; desc: string; done: boolean; tab?: string }> = [
    { label: 'Sync data', desc: hasData ? 'Data is in' : 'Pull from the connected tools', done: hasData, tab: 'data' },
    { label: 'File reports', desc: unfiled > 0 ? `${unfiled} need filing` : 'Repository tidy', done: hasData && unfiled === 0, tab: 'reports' },
    { label: 'Review narrative', desc: 'Edit and approve the story', done: statusAtLeast(meta?.status, 'narrative_approved'), tab: 'overview' },
    { label: 'Schedule', desc: skipped && !scheduled ? 'Client skipped' : scheduled ? 'On the calendar' : 'Send the booking link', done: scheduled || skipped, tab: 'meeting' },
    { label: 'Hold the meeting', desc: skipped ? 'Client skipped this quarter' : 'Capture answers live', done: met || skipped, tab: 'meeting' },
    { label: 'Send package', desc: meta?.packageSentAt ? 'Draft generated' : 'Email draft carries the PDF', done: Boolean(meta?.packageSentAt) },
    { label: 'Complete', desc: completed ? 'Next quarter is up' : 'Close out this QBR', done: completed },
  ];
  const active = steps.findIndex((s) => !s.done);
  const readyToComplete = !completed && steps.slice(0, 6).every((s) => s.done);
  // The escape hatch when the client passes on the review: once the package is
  // out, the QBR can be dispositioned as "meeting skipped" and closed without
  // walking the Schedule / Hold steps.
  const canSkip = !completed && !skipped && Boolean(meta?.packageSentAt);
  const [skipOpen, setSkipOpen] = useState(false);
  const [skipReason, setSkipReason] = useState('');
  const [skipping, setSkipping] = useState(false);
  return (
    <Card withBorder radius="md" padding="md">
      <Stepper
        size="xs"
        active={active === -1 ? steps.length : active}
        onStepClick={(i) => {
          const t = steps[i]?.tab;
          if (t && t !== 'overview') goTab(t);
        }}
      >
        {steps.map((s, i) => (
          <Stepper.Step
            key={s.label}
            label={s.label}
            description={s.desc}
            color={s.done ? 'teal' : undefined}
            completedIcon={<IconCheck size={16} />}
            allowStepSelect={Boolean(steps[i]?.tab)}
          />
        ))}
      </Stepper>
      {(readyToComplete || canSkip) && (
        <Group justify="flex-end" mt="xs">
          {canSkip && (
            <Popover opened={skipOpen} onChange={setSkipOpen} width={340} position="bottom-end" withArrow shadow="md">
              <Popover.Target>
                <Button size="xs" variant="default" leftSection={<IconCalendarOff size={14} />} onClick={() => setSkipOpen((o) => !o)}>
                  Client skipped the meeting
                </Button>
              </Popover.Target>
              <Popover.Dropdown>
                <Stack gap="xs">
                  <Text size="sm" fw={600}>Disposition: meeting skipped</Text>
                  <Text size="xs" c="dimmed">
                    Closes this quarter as completed without a review meeting. The report package already went out; no meeting date is recorded.
                  </Text>
                  <Textarea
                    size="xs"
                    autosize
                    minRows={2}
                    placeholder="Reason (optional) — e.g. client declined, happy with the emailed report"
                    value={skipReason}
                    onChange={(e) => setSkipReason(e.currentTarget.value)}
                  />
                  <Group justify="flex-end" gap="xs">
                    <Button size="xs" variant="default" onClick={() => setSkipOpen(false)}>Cancel</Button>
                    <Button
                      size="xs"
                      color="teal"
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
                      Disposition &amp; complete
                    </Button>
                  </Group>
                </Stack>
              </Popover.Dropdown>
            </Popover>
          )}
          {readyToComplete && (
            <Button size="xs" color="teal" leftSection={<IconCheck size={14} />} onClick={onComplete}>
              Mark this QBR complete
            </Button>
          )}
        </Group>
      )}
    </Card>
  );
}
