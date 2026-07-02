import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Title,
  Group,
  Button,
  Select,
  Tabs,
  Card,
  Text,
  Stack,
  SimpleGrid,
  RingProgress,
  Alert,
  List,
  Loader,
  Center,
  TextInput,
  Textarea,
  ColorInput,
  Checkbox,
  Fieldset,
  ActionIcon,
  Badge,
  FileButton,
  Image,
  Divider,
} from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { RadarChart, BarChart } from '@mantine/charts';
import { notifications } from '@mantine/notifications';
import {
  IconRefresh,
  IconFileText,
  IconFileTypePdf,
  IconPresentation,
  IconAlertTriangle,
  IconTrash,
  IconPlus,
  IconTicket,
  IconTargetArrow,
  IconCalendarEvent,
} from '@tabler/icons-react';
import { api, reportUrls } from '../api.js';
import type { Client, Discussion, QbrResponse, ReportConfig } from '../types.js';
import { RatingBadge, StatusBadge, uid } from '../ui.js';

const PERIODS = ['2026-Q1', '2025-Q4'];
const SECTIONS: Array<[string, string]> = [
  ['operations', 'Operational Stability & Support'],
  ['security', 'Security & Risk'],
  ['identity', 'Identity & Access'],
  ['backup', 'Backup & Recovery'],
  ['infrastructure', 'Infrastructure & Refresh'],
  ['spend', 'IT Spend'],
];
const DISPOSITIONS = ['pending', 'create_opportunity', 'create_ticket', 'accept_risk', 'no_action'];
const STATUSES = ['draft', 'data_synced', 'narrative_approved', 'scheduled', 'completed', 'dispositioned', 'actions_pushed', 'archived'];
const RING_COLOR: Record<string, string> = { green: 'teal', amber: 'yellow', red: 'red', unknown: 'gray' };

export function Workspace() {
  const { clientId = '' } = useParams();
  const [period, setPeriod] = useState(PERIODS[0]!);
  const [qbr, setQbr] = useState<QbrResponse | null>(null);
  const [config, setConfig] = useState<ReportConfig | null>(null);
  const [disc, setDisc] = useState<Discussion | null>(null);
  const [client, setClient] = useState<Client | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    api.listClients().then((d) => setClient(d.clients.find((c) => c.id === clientId) ?? null)).catch(() => {});
    api.getConfig(clientId).then(setConfig).catch(() => setConfig({ clientId }));
  }, [clientId]);

  useEffect(() => {
    if (!clientId) return;
    setLoading(true);
    setError(null);
    api
      .getQbr(clientId, period)
      .then(setQbr)
      .catch((e) => {
        setQbr(null);
        setError(e instanceof Error ? e.message : 'Failed to build QBR');
      })
      .finally(() => setLoading(false));
    api.getDiscussion(clientId, period).then(setDisc).catch(() => setDisc({ clientId, period, items: [] }));
  }, [clientId, period, refresh]);

  async function onSync() {
    setSyncing(true);
    try {
      const r = await api.sync(clientId, period);
      notifications.show({
        color: r.warnings.length ? 'yellow' : 'teal',
        title: `Synced ${r.metrics} metric(s)`,
        message: r.warnings[0] ?? 'Live data pulled from mapped tools.',
      });
      setRefresh((n) => n + 1);
    } catch (e) {
      notifications.show({ color: 'red', title: 'Sync failed', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setSyncing(false);
    }
  }

  const urls = reportUrls(clientId, period);
  const meta = qbr?.meta;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>{qbr?.model.client.name ?? client?.name ?? clientId}</Title>
          <Group gap="xs" mt={4}>
            {meta && <StatusBadge status={meta.status} />}
            {qbr && <RatingBadge rating={qbr.model.scorecard.overall.rating} score={qbr.model.scorecard.overall.score} />}
            {qbr && !qbr.verification && <Badge color="red" variant="light">figures unverified</Badge>}
          </Group>
        </div>
        <Group>
          <Select w={140} data={PERIODS} value={period} onChange={(v) => v && setPeriod(v)} allowDeselect={false} />
          <Button leftSection={<IconRefresh size={16} />} loading={syncing} onClick={onSync}>Sync</Button>
        </Group>
      </Group>

      {error && <Alert color="red" title="Could not build report">{error}. Try running a Sync, or check the client's tool mappings.</Alert>}

      <Tabs defaultValue="report" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="report">Report</Tabs.Tab>
          <Tabs.Tab value="branding">Branding &amp; Sections</Tabs.Tab>
          <Tabs.Tab value="discussion">Discussion &amp; Responses</Tabs.Tab>
          <Tabs.Tab value="workflow">Schedule &amp; Actions</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="report">
          {loading ? <Center h={240}><Loader /></Center> : qbr ? <ReportTab qbr={qbr} urls={urls} /> : <Text c="dimmed">No report.</Text>}
        </Tabs.Panel>

        <Tabs.Panel value="branding">
          {config && <BrandingTab config={config} setConfig={setConfig} clientId={clientId} onSaved={() => setRefresh((n) => n + 1)} />}
        </Tabs.Panel>

        <Tabs.Panel value="discussion">
          {disc && <DiscussionTab disc={disc} setDisc={setDisc} clientId={clientId} period={period} onSaved={() => setRefresh((n) => n + 1)} />}
        </Tabs.Panel>

        <Tabs.Panel value="workflow">
          <WorkflowTab clientId={clientId} period={period} meta={meta} disc={disc} onChanged={() => setRefresh((n) => n + 1)} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

// ── Report tab ────────────────────────────────────────────────────────────────
function ReportTab({ qbr, urls }: { qbr: QbrResponse; urls: { html: string; pdf: string; deck: string } }) {
  const { model } = qbr;
  const score = model.scorecard.overall.score ?? 0;
  const radar = model.scorecard.functions.map((f) => ({ function: f.function, score: f.score ?? 0 }));
  const trendData = useMemo(
    () =>
      model.trends
        .filter((t) => t.current !== null && (t.category === 'operations' || t.category === 'security'))
        .slice(0, 6)
        .map((t) => ({
          label: t.label.length > 14 ? t.label.slice(0, 13) + '…' : t.label,
          previous: t.previous ?? 0,
          current: t.current ?? 0,
        })),
    [model.trends],
  );

  return (
    <Stack gap="lg">
      {qbr.warnings.length > 0 && (
        <Alert color="yellow" icon={<IconAlertTriangle size={18} />} title="Data notes">
          <List size="sm" spacing={2}>{qbr.warnings.map((w, i) => <List.Item key={i}>{w}</List.Item>)}</List>
        </Alert>
      )}

      <Group>
        <Button component="a" href={urls.html} target="_blank" leftSection={<IconFileText size={16} />}>Open report</Button>
        <Button component="a" href={urls.pdf} target="_blank" variant="default" leftSection={<IconFileTypePdf size={16} />}>PDF</Button>
        <Button component="a" href={urls.deck} variant="default" leftSection={<IconPresentation size={16} />}>Deck</Button>
      </Group>

      <Card withBorder radius="md" padding="lg">
        <Title order={4}>{model.period.label} — Executive summary</Title>
        {model.executive.headline && <Text fw={600} c="navy.9" mt={4}>{model.executive.headline}</Text>}
        {model.executive.paragraphs.map((p, i) => <Text key={i} mt="sm" size="sm">{p}</Text>)}
        {model.executive.highlights.length > 0 && (
          <List size="sm" mt="md" spacing={4}>{model.executive.highlights.map((h, i) => <List.Item key={i}>{h}</List.Item>)}</List>
        )}
      </Card>

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Card withBorder radius="md" padding="lg">
          <Title order={5} mb="md">Security maturity</Title>
          <Group>
            <RingProgress
              size={150}
              thickness={14}
              roundCaps
              sections={[{ value: score, color: RING_COLOR[model.scorecard.overall.rating] ?? 'gray' }]}
              label={<Center><Stack gap={0} align="center"><Text fw={700} size="xl">{model.scorecard.overall.score ?? '—'}</Text><Text size="xs" c="dimmed">/ 100</Text></Stack></Center>}
            />
            <Stack gap={4}>
              <RatingBadge rating={model.scorecard.overall.rating} />
              <Text size="sm" c="dimmed">Coverage {Math.round((model.scorecard.overall.coverage ?? 0) * 100)}%</Text>
              <Text size="xs" c="dimmed" maw={180}>Blended CIS Controls v8 under NIST CSF 2.0.</Text>
            </Stack>
          </Group>
        </Card>

        <Card withBorder radius="md" padding="lg">
          <Title order={5} mb="md">Maturity by function</Title>
          {radar.some((r) => r.score > 0) ? (
            <RadarChart h={230} data={radar} dataKey="function" withPolarRadiusAxis series={[{ name: 'score', color: 'teal.7', opacity: 0.35 }]} />
          ) : (
            <Text size="sm" c="dimmed">No function scores available.</Text>
          )}
        </Card>
      </SimpleGrid>

      {trendData.length > 0 && (
        <Card withBorder radius="md" padding="lg">
          <Title order={5} mb="md">Quarter-over-quarter</Title>
          <BarChart
            h={260}
            data={trendData}
            dataKey="label"
            series={[
              { name: 'previous', label: 'Previous', color: 'gray.5' },
              { name: 'current', label: 'Current', color: 'navy.7' },
            ]}
          />
        </Card>
      )}

      {model.recommendations.length > 0 && (
        <Card withBorder radius="md" padding="lg">
          <Title order={5} mb="md">Recommendations &amp; next 90 days</Title>
          <List size="sm" spacing={4}>{model.recommendations.map((r, i) => <List.Item key={i}>{r}</List.Item>)}</List>
        </Card>
      )}
    </Stack>
  );
}

// ── Branding & Sections tab ───────────────────────────────────────────────────
function BrandingTab({
  config,
  setConfig,
  clientId,
  onSaved,
}: {
  config: ReportConfig;
  setConfig: (c: ReportConfig) => void;
  clientId: string;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const brand = config.brand ?? {};

  function onLogo(file: File | null) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setConfig({ ...config, brand: { ...brand, logoDataUri: String(reader.result) } });
    reader.readAsDataURL(file);
  }

  async function save() {
    setSaving(true);
    try {
      await api.putConfig(clientId, { ...config, clientId });
      notifications.show({ color: 'teal', message: 'Branding saved. Report regenerated.' });
      onSaved();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Save failed', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap="lg" maw={760}>
      <Card withBorder radius="md" padding="lg">
        <Title order={5} mb="md">Branding</Title>
        <Stack>
          <TextInput label="Company name" value={brand.name ?? ''} onChange={(e) => setConfig({ ...config, brand: { ...brand, name: e.currentTarget.value } })} />
          <Group grow>
            <ColorInput label="Primary color" value={brand.primary ?? '#0b2545'} onChange={(v) => setConfig({ ...config, brand: { ...brand, primary: v } })} />
            <ColorInput label="Accent color" value={brand.accent ?? '#1d7874'} onChange={(v) => setConfig({ ...config, brand: { ...brand, accent: v } })} />
          </Group>
          <Group align="flex-end">
            <FileButton accept="image/*" onChange={onLogo}>
              {(props) => <Button variant="default" {...props}>Upload logo</Button>}
            </FileButton>
            {brand.logoDataUri && <Image src={brand.logoDataUri} h={40} w="auto" fit="contain" alt="logo" />}
          </Group>
        </Stack>
      </Card>

      <Card withBorder radius="md" padding="lg">
        <Title order={5} mb="md">Sections</Title>
        <Stack gap="xs">
          {SECTIONS.map(([key, label]) => {
            const hidden = config.hiddenSections?.includes(key) ?? false;
            return (
              <Checkbox
                key={key}
                label={label}
                checked={!hidden}
                onChange={(e) => {
                  const set = new Set(config.hiddenSections ?? []);
                  if (e.currentTarget.checked) set.delete(key);
                  else set.add(key);
                  setConfig({ ...config, hiddenSections: [...set] });
                }}
              />
            );
          })}
        </Stack>
      </Card>

      <Card withBorder radius="md" padding="lg">
        <Group justify="space-between" mb="md">
          <Title order={5}>Custom sections</Title>
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setConfig({ ...config, customSections: [...(config.customSections ?? []), { id: uid(), title: '', body: '', placement: 'in-body' }] })}>Add section</Button>
        </Group>
        <Stack>
          {(config.customSections ?? []).map((s, i) => (
            <Fieldset key={s.id} p="sm">
              <Group align="flex-end" mb="xs">
                <TextInput label="Title" style={{ flex: 1 }} value={s.title} onChange={(e) => { const cs = [...(config.customSections ?? [])]; cs[i] = { ...s, title: e.currentTarget.value }; setConfig({ ...config, customSections: cs }); }} />
                <Select
                  label="Placement"
                  w={150}
                  data={[{ value: 'after-summary', label: 'After summary' }, { value: 'in-body', label: 'In body' }, { value: 'end', label: 'At end' }]}
                  value={s.placement ?? 'in-body'}
                  onChange={(v) => { const cs = [...(config.customSections ?? [])]; cs[i] = { ...s, placement: v ?? 'in-body' }; setConfig({ ...config, customSections: cs }); }}
                />
                <ActionIcon color="red" variant="subtle" onClick={() => setConfig({ ...config, customSections: (config.customSections ?? []).filter((x) => x.id !== s.id) })}><IconTrash size={16} /></ActionIcon>
              </Group>
              <Textarea autosize minRows={2} placeholder="Body" value={s.body} onChange={(e) => { const cs = [...(config.customSections ?? [])]; cs[i] = { ...s, body: e.currentTarget.value }; setConfig({ ...config, customSections: cs }); }} />
            </Fieldset>
          ))}
        </Stack>
      </Card>

      <Group><Button loading={saving} onClick={save}>Save &amp; regenerate</Button></Group>
    </Stack>
  );
}

// ── Discussion tab ────────────────────────────────────────────────────────────
function DiscussionTab({
  disc,
  setDisc,
  clientId,
  period,
  onSaved,
}: {
  disc: Discussion;
  setDisc: (d: Discussion) => void;
  clientId: string;
  period: string;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.putDiscussion(clientId, period, disc);
      notifications.show({ color: 'teal', message: 'Discussion saved.' });
      onSaved();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Save failed', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap="lg" maw={820}>
      <Text c="dimmed" size="sm">Capture talking points, client responses, and dispositions live during the review.</Text>
      <Card withBorder radius="md" padding="lg">
        <Group justify="space-between" mb="md">
          <Title order={5}>Discussion items</Title>
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setDisc({ ...disc, items: [...disc.items, { id: uid(), topic: '', response: '', disposition: 'pending' }] })}>Add item</Button>
        </Group>
        <Stack>
          {disc.items.length === 0 && <Text size="sm" c="dimmed">No items yet.</Text>}
          {disc.items.map((it, i) => (
            <Fieldset key={it.id} p="sm">
              <Group justify="space-between" align="flex-start">
                <TextInput style={{ flex: 1 }} placeholder="Topic / question / decision" value={it.topic} onChange={(e) => { const items = [...disc.items]; items[i] = { ...it, topic: e.currentTarget.value }; setDisc({ ...disc, items }); }} />
                <ActionIcon color="red" variant="subtle" onClick={() => setDisc({ ...disc, items: disc.items.filter((x) => x.id !== it.id) })}><IconTrash size={16} /></ActionIcon>
              </Group>
              <Textarea mt="xs" autosize minRows={2} placeholder="Client response & notes" value={it.response ?? ''} onChange={(e) => { const items = [...disc.items]; items[i] = { ...it, response: e.currentTarget.value }; setDisc({ ...disc, items }); }} />
              <Group mt="xs">
                <Select w={200} data={DISPOSITIONS.map((d) => ({ value: d, label: d.replace(/_/g, ' ') }))} value={it.disposition ?? 'pending'} onChange={(v) => { const items = [...disc.items]; items[i] = { ...it, disposition: v ?? 'pending' }; setDisc({ ...disc, items }); }} />
                <TextInput placeholder="Owner" value={it.owner ?? ''} onChange={(e) => { const items = [...disc.items]; items[i] = { ...it, owner: e.currentTarget.value }; setDisc({ ...disc, items }); }} />
                {it.externalRef && <Badge color="green" variant="light">{it.externalRef.system} #{it.externalRef.id}</Badge>}
              </Group>
            </Fieldset>
          ))}
        </Stack>
      </Card>

      <Card withBorder radius="md" padding="lg">
        <Title order={5} mb="md">General notes</Title>
        <Textarea autosize minRows={3} value={disc.notes ?? ''} onChange={(e) => setDisc({ ...disc, notes: e.currentTarget.value })} />
      </Card>

      <Group><Button loading={saving} onClick={save}>Save &amp; regenerate</Button></Group>
    </Stack>
  );
}

// ── Schedule & Actions tab ────────────────────────────────────────────────────
function WorkflowTab({
  clientId,
  period,
  meta,
  disc,
  onChanged,
}: {
  clientId: string;
  period: string;
  meta: QbrResponse['meta'] | undefined;
  disc: Discussion | null;
  onChanged: () => void;
}) {
  const [scheduledAt, setScheduledAt] = useState<Date | null>(meta?.meeting?.scheduledAt ? new Date(meta.meeting.scheduledAt) : null);
  const [joinUrl, setJoinUrl] = useState(meta?.meeting?.joinUrl ?? '');
  const [status, setStatus] = useState(meta?.status ?? 'draft');
  const [savingSched, setSavingSched] = useState(false);
  const [pushing, setPushing] = useState<string | null>(null);

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
      notifications.show({ color: 'red', title: 'Save failed', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setSavingSched(false);
    }
  }

  async function push(actionId: string, target: string) {
    setPushing(actionId + target);
    try {
      const r = await api.pushAction(clientId, period, { actionId, target });
      notifications.show({ color: 'teal', title: 'Pushed', message: `${r.system} #${r.id || '(created)'}` });
      onChanged();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Push failed', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setPushing(null);
    }
  }

  const items = disc?.items ?? [];

  return (
    <Stack gap="lg" maw={820}>
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
            <Select label="Status" data={STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))} value={status} onChange={(v) => v && setStatus(v)} allowDeselect={false} />
          </Group>
          <TextInput label="Teams meeting link" placeholder="https://teams.microsoft.com/l/meetup-join/..." value={joinUrl} onChange={(e) => setJoinUrl(e.currentTarget.value)} />
          <Text size="xs" c="dimmed">Automatic Teams-meeting creation via Microsoft Graph is a fast-follow; for now paste the link.</Text>
          <Group><Button loading={savingSched} onClick={saveSchedule}>Save schedule</Button></Group>
        </Stack>
      </Card>

      <Card withBorder radius="md" padding="lg">
        <Title order={5} mb="md">Push actions</Title>
        <Text c="dimmed" size="sm" mb="md">Turn dispositioned discussion items into Halo tickets/opportunities or Zomentum opportunities.</Text>
        {items.length === 0 ? (
          <Text size="sm" c="dimmed">No discussion items — capture them in the Discussion tab first.</Text>
        ) : (
          <Stack>
            {items.map((it) => (
              <Fieldset key={it.id} p="sm">
                <Group justify="space-between" align="flex-start">
                  <div style={{ flex: 1 }}>
                    <Text fw={600} size="sm">{it.topic || '(untitled)'}</Text>
                    {it.response && <Text size="xs" c="dimmed" lineClamp={2}>{it.response}</Text>}
                  </div>
                  {it.externalRef && <Badge color="green" variant="light">{it.externalRef.system} #{it.externalRef.id}{it.externalRef.status ? ` · ${it.externalRef.status}` : ''}</Badge>}
                </Group>
                <Divider my="xs" />
                <Group gap="xs">
                  <Button size="xs" variant="light" leftSection={<IconTicket size={14} />} loading={pushing === it.id + 'halo_ticket'} onClick={() => push(it.id, 'halo_ticket')}>Halo ticket</Button>
                  <Button size="xs" variant="light" color="teal" leftSection={<IconTargetArrow size={14} />} loading={pushing === it.id + 'halo_opportunity'} onClick={() => push(it.id, 'halo_opportunity')}>Halo opportunity</Button>
                  <Button size="xs" variant="light" color="grape" leftSection={<IconTargetArrow size={14} />} loading={pushing === it.id + 'zomentum_opportunity'} onClick={() => push(it.id, 'zomentum_opportunity')}>Zomentum opportunity</Button>
                </Group>
              </Fieldset>
            ))}
          </Stack>
        )}
      </Card>
    </Stack>
  );
}
