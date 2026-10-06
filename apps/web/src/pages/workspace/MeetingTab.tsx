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
} from '@tabler/icons-react';
import { api } from '../../api.js';
import type { Discussion, DiscussionItem, QbrResponse } from '../../types.js';
import { uid } from '../../ui.js';
import { toastError } from '../../toast.js';
import { QBR_STATUS_ORDER, isQbrStatus } from '@mashit/core';

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
          color: 'yellow',
          message: r.note ?? (suggested ? 'No further talking points to suggest — you\'ve covered the standouts.' : 'No standout talking points from this quarter\'s data yet.'),
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
    notifications.show({ color: 'teal', message: 'Added to the agenda — expand on it below, then Save agenda.' });
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
      notifications.show({ color: 'teal', message: 'Added to the Opportunities board.' });
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
      notifications.show({ color: 'teal', message: 'Agenda saved — answered items flow onto the final report.' });
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
            {planned > 0 && <Badge variant="light" color="grape">{planned} to discuss</Badge>}
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
                A few consultative starters from this quarter's tickets, trends, and posture — accept the ones worth raising,
                then expand on them.
              </Text>
            </div>
            <Button size="compact-sm" variant="light" color="teal" loading={suggesting} leftSection={<IconSparkles size={14} />} onClick={suggestAgenda}>
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
                    <Button size="compact-xs" variant="light" color="teal" onClick={() => acceptSuggestion(s)}>Add</Button>
                    <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Dismiss suggestion" onClick={() => setSuggested((cur) => cur?.filter((x) => x.topic !== s.topic) ?? null)}>
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

        <Group mb="md" wrap="nowrap">
          <TextInput
            style={{ flex: 1 }}
            placeholder="Add a topic to discuss — e.g. Budget for the hardware refresh"
            value={newTopic}
            onChange={(e) => setNewTopic(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addTopic();
            }}
          />
          <Button variant="light" leftSection={<IconPlus size={14} />} onClick={addTopic}>Add topic</Button>
        </Group>

        <Stack>
          {disc.items.length === 0 && <Text size="sm" c="dimmed">No topics yet — add the questions and decisions you want to walk through.</Text>}
          {disc.items.map((it, i) => (
            <Fieldset key={it.id} p="sm">
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <TextInput style={{ flex: 1 }} placeholder="Topic / question / decision" value={it.topic} onChange={(e) => update(i, { topic: e.currentTarget.value })} />
                <Group gap={4} wrap="nowrap">
                  <Tooltip label="Flag as opportunity (adds to the board)">
                    <ActionIcon variant="subtle" color="yellow" aria-label={`Flag "${it.topic || 'topic'}" as opportunity`} onClick={() => flagOpportunity(it)}><IconBulb size={16} /></ActionIcon>
                  </Tooltip>
                  <ActionIcon variant="subtle" aria-label={`Move "${it.topic || 'topic'}" up`} disabled={i === 0} onClick={() => move(i, -1)}><IconArrowUp size={16} /></ActionIcon>
                  <ActionIcon variant="subtle" aria-label={`Move "${it.topic || 'topic'}" down`} disabled={i === disc.items.length - 1} onClick={() => move(i, 1)}><IconArrowDown size={16} /></ActionIcon>
                  <ActionIcon color="red" variant="subtle" aria-label={`Remove "${it.topic || 'topic'}"`} onClick={() => setDisc({ ...disc, items: disc.items.filter((x) => x.id !== it.id) })}><IconTrash size={16} /></ActionIcon>
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
                {it.externalRef && <Badge color="green" variant="light">{it.externalRef.system} #{it.externalRef.id}</Badge>}
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
      notifications.show({ color: 'teal', message: 'Booking link ready — copy it or just send the email draft (it includes the link automatically).' });
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
      notifications.show({ color: 'teal', message: 'Meeting cancelled — create a fresh booking link or set a new time below.' });
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
            A private booking page for this QBR — the client picks a time that's open on your calendar and the Teams
            invite goes out automatically. The link also rides inside the email draft until a meeting is booked.
          </Text>
        </div>
        {booking?.status === 'booked' ? (
          <Badge color="teal">booked</Badge>
        ) : booking?.status === 'open' ? (
          <Badge color="blue" variant="light">link active</Badge>
        ) : null}
      </Group>

      {state && !state.configured && (
        <Alert color="yellow" p="xs" mb="xs">
          <Text size="xs">
            Set the <b>organizer email</b> under Settings → QBR self-scheduling first — that's whose calendar drives
            availability and hosts the invite.
          </Text>
        </Alert>
      )}
      {state && state.configured && !state.calendarConnected && (
        <Alert color="yellow" p="xs" mb="xs">
          <Text size="xs">
            Calendar not connected — the page will offer your configured windows without checking for conflicts, and
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
            {booking.eventId ? ' — Teams invite sent to everyone.' : ' — calendar not connected, send the invite manually.'}
          </Text>
          <Button size="compact-sm" variant="light" color="red" loading={cancelling} onClick={cancelMeeting}>
            Cancel / reschedule
          </Button>
        </Group>
      ) : url ? (
        <Group gap="xs">
          <TextInput readOnly value={url} style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} aria-label="Booking link" />
          <CopyButton value={url}>
            {({ copied, copy }) => (
              <Button variant={copied ? 'filled' : 'light'} color="teal" onClick={copy}>
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
          <Button size="compact-sm" variant="light" color="red" loading={cancelling} onClick={cancelMeeting}>
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
  const [status, setStatus] = useState(meta?.status ?? 'draft');
  const [attendees, setAttendees] = useState('');
  const [savingSched, setSavingSched] = useState(false);
  const [creatingMeeting, setCreatingMeeting] = useState(false);

  useEffect(() => {
    setScheduledAt(meta?.meeting?.scheduledAt ? new Date(meta.meeting.scheduledAt) : null);
    setJoinUrl(meta?.meeting?.joinUrl ?? '');
    setStatus(meta?.status ?? 'draft');
  }, [meta]);

  async function saveSchedule() {
    setSavingSched(true);
    try {
      await api.putSchedule(clientId, period, { scheduledAt: scheduledAt ? scheduledAt.toISOString() : undefined, joinUrl: joinUrl || undefined });
      if (status !== meta?.status) await api.putStatus(clientId, period, status);
      notifications.show({ color: 'teal', message: 'Schedule saved.' });
      onChanged();
    } catch (e) {
      toastError('Save failed', e);
    } finally {
      setSavingSched(false);
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
      notifications.show({ color: 'teal', title: 'Meeting created', message: 'Booked on your calendar with a Teams link — invites are on the way.' });
      onChanged();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      notifications.show({
        color: 'red',
        title: 'Could not create the meeting',
        message:
          msg === 'graph_token_missing'
            ? 'Microsoft 365 scheduling isn’t configured yet — the app needs the Graph calendar permission + token store (see the setup steps in the README).'
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
        <Group grow>
          <DateTimePicker
            label="Meeting date &amp; time"
            placeholder="Pick date and time"
            value={scheduledAt}
            onChange={setScheduledAt}
            leftSection={<IconCalendarEvent size={16} />}
            clearable
          />
          <Select label="Status" data={QBR_STATUS_ORDER.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))} value={status} onChange={(v) => isQbrStatus(v) && setStatus(v)} allowDeselect={false} />
        </Group>
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
            color="grape"
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
