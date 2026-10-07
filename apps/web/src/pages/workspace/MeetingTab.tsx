import { useEffect, useState } from 'react';
import {
  Title,
  Group,
  Button,
  Select,
  Card,
  Text,
  Stack,
  Alert,
  TextInput,
  Textarea,
  Checkbox,
  Fieldset,
  ActionIcon,
  Badge,
  Tooltip,
  SegmentedControl,
  CopyButton,
  Modal,
} from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import {
  IconTrash,
  IconPlus,
  IconCalendarEvent,
  IconVideo,
  IconArrowUp,
  IconArrowDown,
  IconBulb,
  IconSparkles,
  IconMessages,
} from '@tabler/icons-react';
import { api } from '../../api.js';
import type { Discussion, DiscussionItem, QbrResponse, SuggestedConversationsResponse } from '../../types.js';
import { conversationItem, pendingConversations } from './conversations.js';
import { uid } from '../../ui.js';
import { toastError } from '../../toast.js';
import { QBR_STATUS_ORDER, isQbrStatus, qbrStatusLabel, statusAtLeast, type QbrStatus } from '@mashit/core';

const DISPOSITIONS = ['pending', 'create_opportunity', 'create_ticket', 'accept_risk', 'no_action'];

// ── Meeting tab: pre-wire the agenda, fill it in live, schedule the call ──────
export function MeetingTab({
  disc,
  setDisc,
  clientId,
  period,
  meta,
  onSavedDiscussion,
  onChanged,
}: {
  disc: Discussion;
  setDisc: (d: Discussion) => void;
  clientId: string;
  period: string;
  meta: QbrResponse['meta'] | undefined;
  /** Clears the parent's unsaved-agenda guard after a successful save. */
  onSavedDiscussion?: () => void;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [newTopic, setNewTopic] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [suggested, setSuggested] = useState<Array<{ topic: string; rationale: string }> | null>(null);
  const [suggestSource, setSuggestSource] = useState<'ai' | 'offline'>('ai');
  const [convos, setConvos] = useState<SuggestedConversationsResponse | null>(null);
  const [convosLoading, setConvosLoading] = useState(false);
  const [convosError, setConvosError] = useState<string | null>(null);
  const [convosReload, setConvosReload] = useState(0);
  const finalLocked = Boolean(meta?.locks?.final);

  // Conversations from Halo for this quarter (requests, opportunities, CRM notes).
  useEffect(() => {
    let live = true;
    setConvosLoading(true);
    setConvosError(null);
    api
      .suggestedConversations(clientId, period)
      .then((r) => live && setConvos(r))
      .catch((e) => {
        if (!live) return;
        setConvos(null);
        setConvosError(e instanceof Error ? e.message : 'Could not load conversations from Halo');
      })
      .finally(() => live && setConvosLoading(false));
    return () => {
      live = false;
    };
  }, [clientId, period, convosReload]);

  const pendingConvos = convos ? pendingConversations(convos.items, disc.items) : [];

  function addConversation(c: SuggestedConversationsResponse['items'][number]) {
    if (finalLocked) return;
    setDisc({ ...disc, items: [...disc.items, conversationItem(c, convos?.hipaa === true, uid())] });
    notifications.show({ color: 'good', message: 'Added to the agenda, expand on it below, then Save agenda.' });
  }

  function addTopic() {
    const topic = newTopic.trim();
    if (!topic) return;
    setDisc({
      ...disc,
      items: [...disc.items, { id: uid(), topic, status: 'planned', includeInReport: true, disposition: 'pending' }],
    });
    setNewTopic('');
  }

  async function suggestAgenda() {
    setSuggesting(true);
    try {
      // On Refresh, tell the server which topics are already on screen (and any
      // already on the agenda) so it proposes fresh ones instead of repeating.
      const exclude = [...(suggested?.map((s) => s.topic) ?? []), ...disc.items.map((it) => it.topic)].filter(Boolean);
      const r = await api.suggestAgenda(clientId, period, exclude);
      setSuggestSource(r.source);
      if (r.suggestions.length === 0) {
        notifications.show({
          color: 'watch',
          message: r.note ?? (suggested ? 'No further talking points to suggest, you\'ve covered the standouts.' : 'No standout talking points from this quarter\'s data yet.'),
        });
        // Keep the current suggestions on a no-op refresh rather than clearing them.
        if (!suggested) setSuggested([]);
      } else {
        setSuggested(r.suggestions);
      }
    } catch (e) {
      toastError('Could not suggest an agenda', e);
    } finally {
      setSuggesting(false);
    }
  }

  function acceptSuggestion(s: { topic: string; rationale: string }) {
    setDisc({
      ...disc,
      items: [...disc.items, { id: uid(), topic: s.topic, status: 'planned', includeInReport: true, disposition: 'pending' }],
    });
    setSuggested((cur) => cur?.filter((x) => x.topic !== s.topic) ?? null);
    notifications.show({ color: 'good', message: 'Added to the agenda, expand on it below, then Save agenda.' });
  }

  function update(i: number, patch: Partial<DiscussionItem>) {
    const items = [...disc.items];
    items[i] = { ...items[i]!, ...patch };
    setDisc({ ...disc, items });
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= disc.items.length) return;
    const items = [...disc.items];
    [items[i], items[j]] = [items[j]!, items[i]!];
    setDisc({ ...disc, items });
  }

  // "Client mentioned a new location" → one click lands it on the board.
  async function flagOpportunity(it: DiscussionItem) {
    try {
      await api.saveOpportunity(clientId, { title: it.topic || 'QBR opportunity', detail: it.response, sourcePeriod: period });
      notifications.show({ color: 'good', message: 'Added to the Opportunities board.' });
    } catch (e) {
      toastError('Could not flag', e);
    }
  }

  async function save() {
    setSaving(true);
    try {
      // Agenda order is the on-screen order.
      const items = disc.items.map((it, i) => ({ ...it, sortOrder: i }));
      await api.putDiscussion(clientId, period, { ...disc, items });
      setDisc({ ...disc, items });
      notifications.show({ color: 'good', message: 'Agenda saved, answered items flow onto the final report.' });
      onSavedDiscussion?.();
      onChanged();
    } catch (e) {
      toastError('Save failed', e);
    } finally {
      setSaving(false);
    }
  }

  const planned = disc.items.filter((it) => (it.status ?? 'planned') === 'planned').length;

  return (
    <Stack gap="lg" maw={860}>
      <Card withBorder radius="md" padding="lg">
        <Group justify="space-between" mb="xs">
          <div>
            <Title order={5}>Meeting agenda</Title>
            <Text size="xs" c="dimmed">
              Pre-wire the topics you want to cover, answer them live during the meeting, and they land on the final report
              (untick “On report” for internal-only items).
            </Text>
          </div>
          <Group gap="xs">
            {planned > 0 && <Badge variant="light" color="navy">{planned} to discuss</Badge>}
            <Button loading={saving} onClick={save}>Save agenda</Button>
          </Group>
        </Group>

        <Card withBorder radius="sm" bg="var(--mantine-color-teal-0)" padding="sm" mb="md">
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <div>
              <Group gap={6}>
                <IconBulb size={16} color="var(--mantine-color-teal-7)" />
                <Text size="sm" fw={600}>Suggested talking points</Text>
              </Group>
              <Text size="xs" c="dimmed">
                A few consultative starters from this quarter's tickets, trends, and posture, accept the ones worth raising,
                then expand on them.
              </Text>
            </div>
            <Button size="compact-sm" variant="light" color="good" loading={suggesting} leftSection={<IconSparkles size={14} />} onClick={suggestAgenda}>
              {suggested ? 'Refresh' : 'Suggest'}
            </Button>
          </Group>
          {suggested && suggested.length > 0 && (
            <Stack gap={6} mt="sm">
              {suggested.map((s) => (
                <Group key={s.topic} justify="space-between" wrap="nowrap" align="flex-start" bg="white" p="xs" style={{ borderRadius: 6 }}>
                  <div style={{ flex: 1 }}>
                    <Text size="sm" fw={600}>{s.topic}</Text>
                    <Text size="xs" c="dimmed">{s.rationale}</Text>
                  </div>
                  <Group gap={4} wrap="nowrap">
                    <Button size="compact-xs" variant="light" color="good" onClick={() => acceptSuggestion(s)}>Add</Button>
                    <ActionIcon size="sm" variant="subtle" color="slate" aria-label="Dismiss suggestion" onClick={() => setSuggested((cur) => cur?.filter((x) => x.topic !== s.topic) ?? null)}>
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Group>
                </Group>
              ))}
              {suggestSource === 'offline' && (
                <Text size="xs" c="dimmed">Data-driven (AI is off or unavailable).</Text>
              )}
            </Stack>
          )}
        </Card>

        <Card withBorder radius="sm" padding="sm" mb="md">
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <div>
              <Group gap={6}>
                <IconMessages size={16} color="var(--mantine-color-navy-7)" />
                <Text size="sm" fw={600}>Conversations from Halo and email</Text>
              </Group>
              <Text size="xs" c="dimmed">
                Requests from the primary contact or VIPs, opportunities and CRM notes from this quarter. Emails forwarded to the
                client's report address land on the agenda below as drafts.
              </Text>
            </div>
            <Button size="compact-sm" variant="light" loading={convosLoading} onClick={() => setConvosReload((n) => n + 1)}>
              Refresh
            </Button>
          </Group>
          {convosError && <Text size="xs" c="act" mt="xs">{convosError}</Text>}
          {convos && convos.hipaa && pendingConvos.length > 0 && (
            <Text size="xs" c="dimmed" mt="xs">HIPAA client: added items stay off the report until you tick On report.</Text>
          )}
          {convos && !convosLoading && pendingConvos.length === 0 && !convosError && (
            <Text size="xs" c="dimmed" mt="xs">Nothing new from Halo for this quarter.</Text>
          )}
          {pendingConvos.length > 0 && (
            <Stack gap={6} mt="sm">
              {pendingConvos.map((c) => (
                <Group key={c.ref} justify="space-between" wrap="nowrap" align="flex-start" p="xs" style={{ borderRadius: 6, background: 'var(--mantine-color-gray-0)' }}>
                  <div style={{ flex: 1 }}>
                    <Text size="sm" fw={600}>{c.topic}</Text>
                    <Text size="xs" c="dimmed">
                      {[{ halo_ticket: 'Ticket', halo_opportunity: 'Opportunity', halo_note: 'CRM note' }[c.source], c.when, c.detail].filter(Boolean).join(', ')}
                    </Text>
                  </div>
                  <Tooltip label="This quarter is final. Reopen it to change the agenda." disabled={!finalLocked}>
                    <Button size="compact-xs" variant="light" color="good" disabled={finalLocked} onClick={() => addConversation(c)}>Add</Button>
                  </Tooltip>
                </Group>
              ))}
            </Stack>
          )}
          {convos && convos.warnings.length > 0 && (
            <Text size="xs" c="dimmed" mt="xs">{convos.warnings.join(' ')}</Text>
          )}
        </Card>

        <Group mb="md" wrap="nowrap">
          <TextInput
            style={{ flex: 1 }}
            placeholder="Add a topic to discuss, e.g. Budget for the hardware refresh"
            value={newTopic}
            onChange={(e) => setNewTopic(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addTopic();
            }}
          />
          <Button variant="light" leftSection={<IconPlus size={14} />} onClick={addTopic}>Add topic</Button>
        </Group>

        <Stack>
          {disc.items.length === 0 && <Text size="sm" c="dimmed">No topics yet, add the questions and decisions you want to walk through.</Text>}
          {disc.items.map((it, i) => (
            <Fieldset key={it.id} p="sm">
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <TextInput style={{ flex: 1 }} placeholder="Topic / question / decision" value={it.topic} onChange={(e) => update(i, { topic: e.currentTarget.value })} />
                <Group gap={4} wrap="nowrap">
                  <Tooltip label="Flag as opportunity (adds to the board)">
                    <ActionIcon variant="subtle" color="watch" aria-label={`Flag "${it.topic || 'topic'}" as opportunity`} onClick={() => flagOpportunity(it)}><IconBulb size={16} /></ActionIcon>
                  </Tooltip>
                  <ActionIcon variant="subtle" aria-label={`Move "${it.topic || 'topic'}" up`} disabled={i === 0} onClick={() => move(i, -1)}><IconArrowUp size={16} /></ActionIcon>
                  <ActionIcon variant="subtle" aria-label={`Move "${it.topic || 'topic'}" down`} disabled={i === disc.items.length - 1} onClick={() => move(i, 1)}><IconArrowDown size={16} /></ActionIcon>
                  <ActionIcon color="act" variant="subtle" aria-label={`Remove "${it.topic || 'topic'}"`} onClick={() => setDisc({ ...disc, items: disc.items.filter((x) => x.id !== it.id) })}><IconTrash size={16} /></ActionIcon>
                </Group>
              </Group>
              <Textarea
                mt="xs"
                autosize
                minRows={2}
                placeholder="Client response & notes (fill in during the meeting)"
                value={it.response ?? ''}
                onChange={(e) => update(i, { response: e.currentTarget.value, ...(e.currentTarget.value ? { status: 'discussed' as const } : {}) })}
              />
              <Group mt="xs" gap="sm">
                <SegmentedControl
                  size="xs"
                  value={it.status ?? 'planned'}
                  onChange={(v) => update(i, { status: v as 'planned' | 'discussed' })}
                  data={[
                    { value: 'planned', label: 'Planned' },
                    { value: 'discussed', label: 'Discussed' },
                  ]}
                />
                <Select
                  w={180}
                  size="xs"
                  data={DISPOSITIONS.map((d) => ({ value: d, label: d.replace(/_/g, ' ') }))}
                  value={it.disposition ?? 'pending'}
                  onChange={(v) => update(i, { disposition: v ?? 'pending' })}
                  aria-label="Disposition"
                />
                <TextInput size="xs" placeholder="Owner" value={it.owner ?? ''} onChange={(e) => update(i, { owner: e.currentTarget.value })} />
                <Checkbox size="xs" label="On report" checked={it.includeInReport !== false} onChange={(e) => update(i, { includeInReport: e.currentTarget.checked })} />
                {it.externalRef && <Badge color="good" variant="light">{it.externalRef.system} #{it.externalRef.id}</Badge>}
              </Group>
            </Fieldset>
          ))}
        </Stack>
      </Card>

      <Card withBorder radius="md" padding="lg">
        <Group justify="space-between" mb="md">
          <Title order={5}>General notes</Title>
          <Button size="xs" variant="light" loading={saving} onClick={save}>Save notes</Button>
        </Group>
        <Textarea autosize minRows={3} value={disc.notes ?? ''} onChange={(e) => setDisc({ ...disc, notes: e.currentTarget.value })} />
        <Text size="xs" c="dimmed" mt={4}>Notes land on the final report with the discussion. “Save agenda” saves these too.</Text>
      </Card>

      <BookingLinkCard clientId={clientId} period={period} meta={meta} onChanged={onChanged} />

      <ScheduleCard clientId={clientId} period={period} meta={meta} onChanged={onChanged} />
    </Stack>
  );
}

// ── Booking link (client self-scheduling, Microsoft Bookings-style) ──────────
function BookingLinkCard({
  clientId,
  period,
  meta,
  onChanged,
}: {
  clientId: string;
  period: string;
  meta: QbrResponse['meta'] | undefined;
  onChanged: () => void;
}) {
  const [state, setState] = useState<Awaited<ReturnType<typeof api.getBooking>> | null>(null);
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let live = true;
    api.getBooking(clientId, period).then((s) => live && setState(s)).catch(() => live && setState(null));
    return () => {
      live = false;
    };
  }, [clientId, period, meta]);

  async function createLink() {
    setCreating(true);
    try {
      await api.createBookingLink(clientId, period);
      setState(await api.getBooking(clientId, period));
      notifications.show({ color: 'good', message: 'Booking link ready, copy it or just send the email draft (it includes the link automatically).' });
    } catch (e) {
      toastError('Could not create the link', e);
    } finally {
      setCreating(false);
    }
  }

  async function cancelMeeting() {
    if (!window.confirm('Cancel this scheduled meeting? The Teams calendar event is removed and the booking link reopens so a new time can be picked.')) return;
    setCancelling(true);
    try {
      await api.cancelMeeting(clientId, period);
      setState(await api.getBooking(clientId, period));
      notifications.show({ color: 'good', message: 'Meeting cancelled, create a fresh booking link or set a new time below.' });
      onChanged();
    } catch (e) {
      toastError('Could not cancel', e);
    } finally {
      setCancelling(false);
    }
  }

  const booking = state?.booking;
  const url = state?.path ? `${window.location.origin}${state.path}` : null;
  const scheduled = Boolean(meta?.meeting?.scheduledAt);

  return (
    <Card withBorder radius="md" padding="lg">
      <Group justify="space-between" mb="xs">
        <div>
          <Title order={5}>Client self-scheduling</Title>
          <Text size="xs" c="dimmed">
            A private booking page for this QBR, the client picks a time that's open on your calendar and the Teams
            invite goes out automatically. The link also rides inside the email draft until a meeting is booked.
          </Text>
        </div>
        {booking?.status === 'booked' ? (
          <Badge color="good">booked</Badge>
        ) : booking?.status === 'open' ? (
          <Badge color="brand" variant="light">link active</Badge>
        ) : null}
      </Group>

      {state && !state.configured && (
        <Alert color="watch" p="xs" mb="xs">
          <Text size="xs">
            Set the <b>organizer email</b> under Settings → QBR self-scheduling first, that's whose calendar drives
            availability and hosts the invite.
          </Text>
        </Alert>
      )}
      {state && state.configured && !state.calendarConnected && (
        <Alert color="watch" p="xs" mb="xs">
          <Text size="xs">
            Calendar not connected, the page will offer your configured windows without checking for conflicts, and
            you'll send the invite yourself. Grant <b>Calendars.ReadWrite</b> (application) to the report-inbox app
            registration to automate it (see Settings).
          </Text>
        </Alert>
      )}

      {booking?.status === 'booked' ? (
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Text size="sm">
            <b>{booking.attendeeName}</b> ({booking.attendeeEmail}) booked{' '}
            <b>{booking.start?.replace('T', ' at ')}</b> ({booking.timezone})
            {booking.eventId ? '. A Teams invite went to everyone.' : '. The calendar is not connected, so send the invite yourself.'}
          </Text>
          <Button size="compact-sm" variant="light" color="act" loading={cancelling} onClick={cancelMeeting}>
            Cancel / reschedule
          </Button>
        </Group>
      ) : url ? (
        <Group gap="xs">
          <TextInput readOnly value={url} style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} aria-label="Booking link" />
          <CopyButton value={url}>
            {({ copied, copy }) => (
              <Button variant={copied ? 'filled' : 'light'} color="good" onClick={copy}>
                {copied ? 'Copied' : 'Copy link'}
              </Button>
            )}
          </CopyButton>
        </Group>
      ) : scheduled ? (
        <Group justify="space-between" align="center" wrap="nowrap">
          <Text size="sm" c="dimmed">
            A meeting is on the calendar for {new Date(meta!.meeting!.scheduledAt!).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.
          </Text>
          <Button size="compact-sm" variant="light" color="act" loading={cancelling} onClick={cancelMeeting}>
            Cancel / reschedule
          </Button>
        </Group>
      ) : (
        <Button variant="light" loading={creating} onClick={createLink}>
          Create booking link
        </Button>
      )}
    </Card>
  );
}

// ── Schedule card (Teams meeting / manual link / status override) ─────────────
function ScheduleCard({
  clientId,
  period,
  meta,
  onChanged,
}: {
  clientId: string;
  period: string;
  meta: QbrResponse['meta'] | undefined;
  onChanged: () => void;
}) {
  const [scheduledAt, setScheduledAt] = useState<Date | null>(meta?.meeting?.scheduledAt ? new Date(meta.meeting.scheduledAt) : null);
  const [joinUrl, setJoinUrl] = useState(meta?.meeting?.joinUrl ?? '');
  const [attendees, setAttendees] = useState('');
  const [savingSched, setSavingSched] = useState(false);
  const [creatingMeeting, setCreatingMeeting] = useState(false);
  // Status override: the lifecycle moves forward on its own; moving it by hand
  // is an audited exception with a reason, never a dropdown next to the date.
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideStatus, setOverrideStatus] = useState<QbrStatus>(meta?.status ?? 'draft');
  const [overrideReason, setOverrideReason] = useState('');
  const [overriding, setOverriding] = useState(false);
  const currentStatus: QbrStatus = meta?.status ?? 'draft';
  const backwards = !statusAtLeast(overrideStatus, currentStatus);

  useEffect(() => {
    setScheduledAt(meta?.meeting?.scheduledAt ? new Date(meta.meeting.scheduledAt) : null);
    setJoinUrl(meta?.meeting?.joinUrl ?? '');
    setOverrideStatus(meta?.status ?? 'draft');
  }, [meta]);

  async function saveSchedule() {
    setSavingSched(true);
    try {
      await api.putSchedule(clientId, period, { scheduledAt: scheduledAt ? scheduledAt.toISOString() : undefined, joinUrl: joinUrl || undefined });
      notifications.show({ color: 'good', message: 'Schedule saved.' });
      onChanged();
    } catch (e) {
      toastError('Save failed', e);
    } finally {
      setSavingSched(false);
    }
  }

  async function applyOverride() {
    setOverriding(true);
    try {
      await api.putStatus(clientId, period, backwards ? { status: overrideStatus, force: true, reason: overrideReason.trim() } : { status: overrideStatus });
      notifications.show({ color: 'good', message: `Status set to ${qbrStatusLabel(overrideStatus)}.` });
      setOverrideOpen(false);
      setOverrideReason('');
      onChanged();
    } catch (e) {
      toastError('Could not change the status', e);
    } finally {
      setOverriding(false);
    }
  }

  async function createTeamsMeeting() {
    if (!scheduledAt) return;
    setCreatingMeeting(true);
    try {
      const r = await api.createMeeting(clientId, period, {
        start: scheduledAt.toISOString(),
        attendees: attendees.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean),
      });
      if (r.joinUrl) setJoinUrl(r.joinUrl);
      notifications.show({ color: 'good', title: 'Meeting created', message: 'Booked on your calendar with a Teams link, invites are on the way.' });
      onChanged();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      notifications.show({
        color: 'act',
        title: 'Could not create the meeting',
        message:
          msg === 'graph_token_missing'
            ? 'Microsoft 365 scheduling isn’t configured yet, the app needs the Graph calendar permission + token store (see the setup steps in the README).'
            : msg,
        autoClose: 8000,
      });
    } finally {
      setCreatingMeeting(false);
    }
  }

  return (
    <Card withBorder radius="md" padding="lg">
      <Title order={5} mb="md">Schedule</Title>
      <Stack>
        <Group grow align="flex-end">
          <DateTimePicker
            label="Meeting date and time"
            placeholder="Pick a date and time"
            value={scheduledAt}
            onChange={setScheduledAt}
            leftSection={<IconCalendarEvent size={16} />}
            clearable
          />
          <Group gap="xs" align="center" wrap="nowrap">
            <Text size="sm" c="dimmed">Status: {qbrStatusLabel(currentStatus)}</Text>
            <Button size="compact-xs" variant="subtle" color="slate" onClick={() => setOverrideOpen(true)}>
              Override
            </Button>
          </Group>
        </Group>
        <Modal opened={overrideOpen} onClose={() => setOverrideOpen(false)} title={<Text fw={600}>Override the status</Text>} centered radius="md">
          <Stack gap="sm">
            <Text size="sm">
              The lifecycle moves forward on its own as you work. Use this only to correct a mistake. Moving backwards is written to the audit log with your reason.
            </Text>
            <Select
              label="Set status to"
              data={QBR_STATUS_ORDER.map((s) => ({ value: s, label: qbrStatusLabel(s) }))}
              value={overrideStatus}
              onChange={(v) => isQbrStatus(v) && setOverrideStatus(v)}
              allowDeselect={false}
            />
            {backwards && (
              <>
                <Alert color="watch" variant="light" p="xs">
                  <Text size="xs">
                    Moving back from {qbrStatusLabel(currentStatus)} reopens the quarter on the dashboard
                    {statusAtLeast(currentStatus, 'completed') ? ' and clears the recorded review date' : ''}.
                  </Text>
                </Alert>
                <Textarea
                  label="Reason (required)"
                  placeholder="e.g. closed by mistake, the meeting is next week"
                  autosize
                  minRows={2}
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.currentTarget.value)}
                />
              </>
            )}
            <Group justify="flex-end" gap="xs" mt="xs">
              <Button variant="default" onClick={() => setOverrideOpen(false)} disabled={overriding}>
                Cancel
              </Button>
              <Button
                color={backwards ? 'watch' : 'brand'}
                loading={overriding}
                disabled={overrideStatus === currentStatus || (backwards && !overrideReason.trim())}
                onClick={applyOverride}
              >
                {backwards ? 'Override and log it' : 'Set status'}
              </Button>
            </Group>
          </Stack>
        </Modal>
        <TextInput label="Teams meeting link" placeholder="https://teams.microsoft.com/l/meetup-join/..." value={joinUrl} onChange={(e) => setJoinUrl(e.currentTarget.value)} />
        <TextInput
          label="Attendees (comma-separated, for Create Teams meeting)"
          placeholder="anne@client.com, cfo@client.com"
          value={attendees}
          onChange={(e) => setAttendees(e.currentTarget.value)}
        />
        <Group>
          <Button loading={savingSched} onClick={saveSchedule}>Save schedule</Button>
          <Button
            variant="light"
            color="navy"
            leftSection={<IconVideo size={16} />}
            loading={creatingMeeting}
            disabled={!scheduledAt}
            onClick={createTeamsMeeting}
          >
            Create Teams meeting
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          Create Teams meeting books it on <b>your</b> M365 calendar with a Teams link (invites go to the attendees) and fills the
          link above automatically. Or paste a link manually and just Save.
        </Text>
      </Stack>
    </Card>
  );
}
