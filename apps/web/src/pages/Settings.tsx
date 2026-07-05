import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Chip,
  Code,
  ColorInput,
  FileButton,
  Group,
  Image,
  List,
  Loader,
  Center,
  NumberInput,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconUpload, IconTrash } from '@tabler/icons-react';
import { api } from '../api.js';
import type { BookingSettings, SystemInfo } from '../types.js';

const WEEKDAYS: Array<{ value: string; label: string }> = [
  { value: '1', label: 'Mon' },
  { value: '2', label: 'Tue' },
  { value: '3', label: 'Wed' },
  { value: '4', label: 'Thu' },
  { value: '5', label: 'Fri' },
  { value: '6', label: 'Sat' },
  { value: '0', label: 'Sun' },
];
const TIMEZONES = [
  'America/Detroit',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
];

const MAX_LOGO_BYTES = 500 * 1024;

/** Read an image file as a data URI (stored inline so reports stay self-contained). */
function readAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Org-level settings: the Mash IT logo + house colors used as the DEFAULT
 * branding on every deliverable (PDF cover, deck master, report header).
 * Per-client overrides in the workspace Studio still layer on top.
 */
export function Settings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [logo, setLogo] = useState<string | undefined>();
  const [primary, setPrimary] = useState('');
  const [accent, setAccent] = useState('');
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [polling, setPolling] = useState(false);
  const [booking, setBooking] = useState<BookingSettings>({});
  const [savingBooking, setSavingBooking] = useState(false);

  // Manual inbox check: surfaces the ACTUAL Graph/token error when ingestion
  // is misconfigured, instead of waiting on the silent 5-minute timer.
  async function checkInbox() {
    setPolling(true);
    try {
      const r = await api.pollInbox();
      const folders = r.folders?.map((f) => `${f.folder}: ${f.unread} unread of ${f.total}`).join(' · ');
      notifications.show({
        color: 'teal',
        title: 'Inbox checked',
        message: `${r.filed} attachment(s) filed, ${r.unrouted} unrouted, ${r.processed} unread message(s) seen.${folders ? ` ${folders}.` : ''}`,
        autoClose: 10000,
      });
    } catch (e) {
      notifications.show({ color: 'red', title: 'Inbox check failed', message: e instanceof Error ? e.message : 'Unknown error', autoClose: 12000 });
    } finally {
      setPolling(false);
      api.systemFresh().then(setSystem).catch(() => {});
    }
  }

  useEffect(() => {
    api.system().then(setSystem).catch(() => {});
  }, []);

  useEffect(() => {
    let live = true;
    api
      .getOrgSettings()
      .then(({ brand, booking: b }) => {
        if (!live) return;
        setName(brand.name ?? '');
        setLogo(brand.logoDataUri);
        setPrimary(brand.primary ?? '');
        setAccent(brand.accent ?? '');
        setBooking(b ?? {});
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  async function pickLogo(file: File | null) {
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) {
      notifications.show({ color: 'red', message: 'Keep the logo under 500 KB (PNG/JPEG/SVG).' });
      return;
    }
    try {
      setLogo(await readAsDataUri(file));
    } catch (e) {
      notifications.show({ color: 'red', message: e instanceof Error ? e.message : 'Could not read the file.' });
    }
  }

  const brandBody = () => ({ name: name || undefined, logoDataUri: logo, primary: primary || undefined, accent: accent || undefined });

  async function save() {
    setSaving(true);
    try {
      await api.putOrgSettings(brandBody(), booking);
      notifications.show({ color: 'teal', message: 'Branding saved — every report, PDF and deck now carries it.' });
    } catch (e) {
      notifications.show({ color: 'red', title: 'Save failed', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setSaving(false);
    }
  }

  async function saveBooking() {
    setSavingBooking(true);
    try {
      await api.putOrgSettings(brandBody(), booking);
      notifications.show({ color: 'teal', message: 'Booking rules saved — every scheduling link uses them immediately.' });
    } catch (e) {
      notifications.show({ color: 'red', title: 'Save failed', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setSavingBooking(false);
    }
  }

  if (loading) {
    return (
      <Center h={200}>
        <Loader />
      </Center>
    );
  }

  return (
    <Stack gap="lg" maw={640}>
      <div>
        <Title order={2}>Settings</Title>
        <Text c="dimmed" size="sm">
          Default branding for every deliverable. Until a logo is uploaded, a built-in Mash IT wordmark is used.
        </Text>
      </div>

      <Card withBorder radius="md" padding="lg">
        <Stack>
          <Text fw={600}>Company logo</Text>
          {logo ? (
            <Image src={logo} alt="Company logo" h={72} w="auto" fit="contain" style={{ alignSelf: 'flex-start' }} />
          ) : (
            <Text size="sm" c="dimmed">No logo uploaded — the built-in wordmark is used on reports.</Text>
          )}
          <Group>
            <FileButton onChange={pickLogo} accept="image/png,image/jpeg,image/svg+xml,image/webp">
              {(props) => (
                <Button {...props} variant="light" leftSection={<IconUpload size={16} />}>
                  {logo ? 'Replace logo' : 'Upload logo'}
                </Button>
              )}
            </FileButton>
            {logo && (
              <Button variant="subtle" color="red" leftSection={<IconTrash size={16} />} onClick={() => setLogo(undefined)}>
                Remove
              </Button>
            )}
          </Group>

          <TextInput label="Company name on reports" placeholder="Mash IT" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          {/* No eyedropper: the browser EyeDropper API has hung Chrome in the field. */}
          <Group grow>
            <ColorInput label="Primary color" placeholder="#0b2545" value={primary} onChange={setPrimary} withEyeDropper={false} />
            <ColorInput label="Accent color" placeholder="#1d7874" value={accent} onChange={setAccent} withEyeDropper={false} />
          </Group>

          <Group justify="flex-end">
            <Button loading={saving} onClick={save}>Save branding</Button>
          </Group>
        </Stack>
      </Card>

      <Card withBorder radius="md" padding="lg">
        <Group justify="space-between" mb={4}>
          <Text fw={600}>QBR self-scheduling (booking page)</Text>
          {system?.bookingGraphReady ? (
            <Badge color="teal" variant="light">calendar connected</Badge>
          ) : (
            <Badge color="gray" variant="light">calendar not connected</Badge>
          )}
        </Group>
        <Text size="sm" c="dimmed" mb="sm">
          Each client gets a private booking link (on the Meeting tab and inside the QBR email draft). They pick a time
          that's open on your calendar; a Teams invite goes to both of you automatically. Availability = the rules below
          minus busy times on the organizer's Microsoft 365 calendar.
        </Text>
        <Stack gap="xs">
          <Group grow>
            <TextInput
              label="Organizer (whose calendar hosts the meeting)"
              placeholder="jason.mashni@mashit.net"
              value={booking.organizerEmail ?? ''}
              onChange={(e) => setBooking({ ...booking, organizerEmail: e.currentTarget.value })}
            />
            <TextInput
              label="Meeting title"
              placeholder="Quarterly Business Review"
              value={booking.title ?? ''}
              onChange={(e) => setBooking({ ...booking, title: e.currentTarget.value })}
            />
          </Group>
          <Textarea
            label="Description (shown on the booking page and the invite)"
            placeholder="A review of your IT operations, security posture, and roadmap for the quarter."
            autosize
            minRows={2}
            value={booking.description ?? ''}
            onChange={(e) => setBooking({ ...booking, description: e.currentTarget.value })}
          />
          <div>
            <Text size="sm" fw={500} mb={4}>Bookable days</Text>
            <Chip.Group
              multiple
              value={(booking.daysOfWeek ?? [1, 2, 3, 4, 5]).map(String)}
              onChange={(v) => setBooking({ ...booking, daysOfWeek: v.map(Number).sort() })}
            >
              <Group gap={6}>
                {WEEKDAYS.map((d) => (
                  <Chip key={d.value} value={d.value} size="xs">{d.label}</Chip>
                ))}
              </Group>
            </Chip.Group>
          </div>
          <Group grow>
            <TextInput
              label="Day starts"
              placeholder="09:00"
              value={booking.dayStart ?? ''}
              onChange={(e) => setBooking({ ...booking, dayStart: e.currentTarget.value })}
            />
            <TextInput
              label="Day ends"
              placeholder="17:00"
              value={booking.dayEnd ?? ''}
              onChange={(e) => setBooking({ ...booking, dayEnd: e.currentTarget.value })}
            />
            <Select
              label="Timezone"
              data={TIMEZONES}
              searchable
              value={booking.timezone ?? 'America/Detroit'}
              onChange={(v) => v && setBooking({ ...booking, timezone: v })}
            />
          </Group>
          <Group grow>
            <NumberInput
              label="Meeting length (min)"
              min={15}
              max={240}
              step={15}
              value={booking.durationMinutes ?? 60}
              onChange={(v) => setBooking({ ...booking, durationMinutes: typeof v === 'number' ? v : undefined })}
            />
            <NumberInput
              label="Slot granularity (min)"
              min={15}
              max={120}
              step={15}
              value={booking.incrementMinutes ?? 30}
              onChange={(v) => setBooking({ ...booking, incrementMinutes: typeof v === 'number' ? v : undefined })}
            />
            <NumberInput
              label="Minimum notice (hours)"
              min={0}
              max={720}
              value={booking.leadHours ?? 24}
              onChange={(v) => setBooking({ ...booking, leadHours: typeof v === 'number' ? v : undefined })}
            />
            <NumberInput
              label="Bookable window (days out)"
              min={1}
              max={365}
              value={booking.maxDaysOut ?? 45}
              onChange={(v) => setBooking({ ...booking, maxDaysOut: typeof v === 'number' ? v : undefined })}
            />
          </Group>
          <Group justify="flex-end">
            <Button loading={savingBooking} onClick={saveBooking}>Save booking rules</Button>
          </Group>
        </Stack>
        <Text size="sm" fw={600} mt="sm" mb={4}>One-time setup (for live availability + automatic invites)</Text>
        <List type="ordered" size="sm" spacing={4}>
          <List.Item>
            On the same app registration as the report inbox: API permissions → <b>Microsoft Graph → Application →
            Calendars.ReadWrite</b> → Grant admin consent. (The booking page reuses <Code>REPORTS_TENANT_ID</Code> /{' '}
            <Code>REPORTS_CLIENT_ID</Code> / <Code>REPORTS_CLIENT_SECRET</Code>.)
          </List.Item>
          <List.Item>
            Function App → Authentication → your identity provider → <b>Edit</b> → add <Code>/book/*</Code> and{' '}
            <Code>/api/book/*</Code> to <b>Excluded paths</b> — clients open the booking page without signing in.
          </List.Item>
          <List.Item>Set the organizer email above and save. Without the Graph permission the page still works, but shows configured windows only and you send the invite yourself.</List.Item>
        </List>
      </Card>

      <Card withBorder radius="md" padding="lg">
        <Group justify="space-between" mb={4}>
          <Text fw={600}>Report inbox (email ingestion)</Text>
          <Group gap="xs">
            {system?.reportsMailbox ? (
              <Badge color="teal" variant="light">active · {system.reportsMailbox}</Badge>
            ) : (
              <Badge color="gray" variant="light">not configured</Badge>
            )}
            <Button size="compact-xs" variant="light" loading={polling} onClick={checkInbox}>
              Check now
            </Button>
          </Group>
        </Group>
        {system?.inboxLastPoll && (
          <Text size="xs" c={system.inboxLastPoll.ok ? 'dimmed' : 'red.7'} mb={6}>
            Last check {new Date(system.inboxLastPoll.at).toLocaleString()} — {system.inboxLastPoll.detail}
          </Text>
        )}
        {!system?.reportsMailbox && system?.inboxEnvSeen && (
          <Text size="xs" c="red.7" mb={6}>
            App settings the API can't see:{' '}
            {Object.entries(system.inboxEnvSeen)
              .filter(([, seen]) => !seen)
              .map(([k]) => k)
              .join(', ') || 'none — all four are visible; restart the app and refresh this page'}
            . (Set them under Function App → Environment variables and press <b>Apply</b>.)
          </Text>
        )}
        <Text size="sm" c="dimmed" mb="sm">
          Every client gets its own address on one shared mailbox — <Code>qbr-reports+&#123;client-id&#125;@yourdomain</Code>.
          Schedule vendor reports (Check Point, NinjaOne, Dropsuite…) to send there, or forward them yourself, and the
          attachments file onto that client's QBR automatically (checked every 5 minutes). This builds the per-client
          repository of quarterly reports; each client's exact address shows on its workspace <b>Data</b> tab.
        </Text>
        <Text size="sm" fw={600} mb={4}>One-time setup</Text>
        <List type="ordered" size="sm" spacing={4}>
          <List.Item>
            Create a shared mailbox in Microsoft 365, e.g. <Code>qbr-reports@mashit.net</Code> (plus-addressing is on by default).
          </List.Item>
          <List.Item>
            Entra → App registrations → new app → API permissions → <b>Microsoft Graph → Application → Mail.ReadWrite</b> → Grant
            admin consent. Create a client secret. (Recommended: scope it to just this mailbox with an ApplicationAccessPolicy.)
          </List.Item>
          <List.Item>
            Function App → Environment variables: <Code>REPORTS_MAILBOX</Code>, <Code>REPORTS_TENANT_ID</Code>,{' '}
            <Code>REPORTS_CLIENT_ID</Code>, <Code>REPORTS_CLIENT_SECRET</Code> (put the secret in Key Vault and use a Key Vault
            reference). Restart the app.
          </List.Item>
        </List>
        <Text size="xs" c="dimmed" mt="sm">
          Tip: add a quarter tag like “2026-Q3” to a forwarded email's subject to file it into a specific quarter.
        </Text>
      </Card>
    </Stack>
  );
}
