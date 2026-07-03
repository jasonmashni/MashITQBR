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
  Tooltip,
  Table,
  Modal,
  Anchor,
  SegmentedControl,
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
  IconPencil,
  IconMailForward,
  IconVideo,
  IconUpload,
  IconArrowUp,
  IconArrowDown,
  IconPaperclip,
} from '@tabler/icons-react';
import { api, documentUrl, reportUrls } from '../api.js';
import { lastPeriods } from '../periods.js';
import type {
  Client,
  Discussion,
  DiscussionItem,
  DocumentInfo,
  HaloMeta,
  MetricRow,
  QbrResponse,
  ReportConfig,
  ReportModel,
  SnapshotView,
  SystemInfo,
} from '../types.js';
import { RatingBadge, StatusBadge, uid } from '../ui.js';

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

/**
 * The QBR workspace, organized around the working flow: everything you
 * deliver is one click in the sticky header; the tabs follow the lifecycle —
 * Overview (what the client sees), Data (what feeds it), Meeting (prep + run
 * the review), Actions (what happens after), Studio (shape the report).
 */
export function Workspace() {
  const { clientId = '' } = useParams();
  const [periods, setPeriods] = useState<Array<{ value: string; label: string }>>([]);
  const [period, setPeriod] = useState('');
  const [qbr, setQbr] = useState<QbrResponse | null>(null);
  const [config, setConfig] = useState<ReportConfig | null>(null);
  const [disc, setDisc] = useState<Discussion | null>(null);
  const [client, setClient] = useState<Client | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    api.listClients().then((d) => setClient(d.clients.find((c) => c.id === clientId) ?? null)).catch(() => {});
    api.getConfig(clientId).then(setConfig).catch(() => setConfig({ clientId }));
    api.system().then(setSystem).catch(() => {});
  }, [clientId]);

  // One call tells us which of the last 8 quarters have data; land on the
  // newest one that does (else the current quarter).
  useEffect(() => {
    let live = true;
    api
      .periods(clientId)
      .then(({ periods: list }) => {
        if (!live) return;
        setPeriods(list.map((p) => ({ value: p.period, label: p.hasSnapshot ? p.period : `${p.period} — no data` })));
        const first = list.find((p) => p.hasSnapshot) ?? list[0];
        if (first) setPeriod(first.period);
      })
      .catch(() => {
        if (!live) return;
        const options = lastPeriods('2026-Q1', 4);
        setPeriods(options.map((p) => ({ value: p, label: p })));
        setPeriod(options[0]!);
      });
    return () => {
      live = false;
    };
  }, [clientId]);

  useEffect(() => {
    if (!clientId || !period) return;
    let live = true;
    setLoading(true);
    setError(null);
    api
      .getQbr(clientId, period)
      .then((r) => live && setQbr(r))
      .catch((e) => {
        if (!live) return;
        setQbr(null);
        setError(e instanceof Error ? e.message : 'Failed to build QBR');
      })
      .finally(() => live && setLoading(false));
    api
      .getDiscussion(clientId, period)
      .then((d) => live && setDisc(d))
      .catch(() => live && setDisc({ clientId, period, items: [] }));
    return () => {
      live = false;
    };
  }, [clientId, period, refresh]);

  async function onSync() {
    setSyncing(true);
    try {
      const r = await api.sync(clientId, period);
      notifications.show({
        color: r.warnings.length ? 'yellow' : 'teal',
        title: `Synced ${r.metrics} metric(s)${r.documents ? ` + ${r.documents} vendor report(s)` : ''}`,
        message: r.warnings[0] ?? 'Live data pulled from the connected tools.',
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
        <Group gap="xs">
          <Select
            w={180}
            data={periods}
            value={period || null}
            onChange={(v) => v && setPeriod(v)}
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

      {error && <Alert color="red" title="Could not build report">{error}. Try running a Sync, or check the client's tool mappings.</Alert>}

      <Tabs defaultValue="overview" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="overview">Overview</Tabs.Tab>
          <Tabs.Tab value="data">Data</Tabs.Tab>
          <Tabs.Tab value="meeting">Meeting</Tabs.Tab>
          <Tabs.Tab value="actions">Actions</Tabs.Tab>
          <Tabs.Tab value="studio">Studio</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="overview">
          {loading || !period ? (
            <Center h={240}><Loader /></Center>
          ) : qbr ? (
            <OverviewTab
              qbr={qbr}
              clientId={clientId}
              period={period}
              refresh={refresh}
              aiEnabled={system?.ai ?? false}
              onChanged={() => setRefresh((n) => n + 1)}
            />
          ) : (
            <Text c="dimmed">No report.</Text>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="data">
          {period && config && (
            <Stack gap="lg" maw={900}>
              <DataTab clientId={clientId} period={period} config={config} setConfig={setConfig} refresh={refresh} onSaved={() => setRefresh((n) => n + 1)} />
              <DocumentsCard clientId={clientId} period={period} refresh={refresh} onChanged={() => setRefresh((n) => n + 1)} />
            </Stack>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="meeting">
          {disc && (
            <MeetingTab
              disc={disc}
              setDisc={setDisc}
              clientId={clientId}
              period={period}
              meta={meta}
              onChanged={() => setRefresh((n) => n + 1)}
            />
          )}
        </Tabs.Panel>

        <Tabs.Panel value="actions">
          <ActionsTab clientId={clientId} period={period} disc={disc} onChanged={() => setRefresh((n) => n + 1)} />
        </Tabs.Panel>

        <Tabs.Panel value="studio">
          {config && <StudioTab config={config} setConfig={setConfig} clientId={clientId} onSaved={() => setRefresh((n) => n + 1)} />}
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

// ── Overview tab: what the client will see, editable in place ────────────────
function OverviewTab({
  qbr,
  clientId,
  period,
  refresh,
  aiEnabled,
  onChanged,
}: {
  qbr: QbrResponse;
  clientId: string;
  period: string;
  refresh: number;
  aiEnabled: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [docs, setDocs] = useState<DocumentInfo[]>([]);
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

  useEffect(() => {
    let live = true;
    api.listDocuments(clientId, period).then((d) => live && setDocs(d.documents)).catch(() => {});
    return () => {
      live = false;
    };
  }, [clientId, period, refresh]);

  return (
    <Stack gap="lg">
      {qbr.warnings.length > 0 && (
        <Alert color="yellow" icon={<IconAlertTriangle size={18} />} title="Data notes">
          <List size="sm" spacing={2}>{qbr.warnings.map((w, i) => <List.Item key={i}>{w}</List.Item>)}</List>
        </Alert>
      )}

      <Card withBorder radius="md" padding="lg">
        <Group justify="space-between" align="flex-start">
          <Title order={4}>{model.period.label} — Executive summary</Title>
          <Button size="xs" variant="light" leftSection={<IconPencil size={14} />} onClick={() => setEditing((e) => !e)}>
            {editing ? 'Close editor' : 'Edit narrative'}
          </Button>
        </Group>
        {model.executive.headline && <Text fw={600} c="navy.9" mt={4}>{model.executive.headline}</Text>}
        {model.executive.paragraphs.map((p, i) => <Text key={i} mt="sm" size="sm">{p}</Text>)}
        {model.executive.highlights.length > 0 && (
          <List size="sm" mt="md" spacing={4}>{model.executive.highlights.map((h, i) => <List.Item key={i}>{h}</List.Item>)}</List>
        )}
      </Card>

      {editing && (
        <NarrativeEditor
          clientId={clientId}
          period={period}
          model={model}
          aiEnabled={aiEnabled}
          status={qbr.meta.status}
          onChanged={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}

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

      {docs.length > 0 && (
        <Card withBorder radius="md" padding="lg">
          <Title order={5} mb="sm">Attached reports</Title>
          <Group gap="xs">
            {docs.map((d) => (
              <Badge
                key={d.id}
                component="a"
                href={documentUrl(clientId, period, d.id)}
                variant="light"
                color="navy"
                leftSection={<IconPaperclip size={12} />}
                style={{ cursor: 'pointer', textTransform: 'none' }}
              >
                {d.name}
              </Badge>
            ))}
          </Group>
          <Text size="xs" c="dimmed" mt={6}>These appear in the report appendix. Manage them on the Data tab.</Text>
        </Card>
      )}
    </Stack>
  );
}

// ── Narrative editor ──────────────────────────────────────────────────────────
function NarrativeEditor({
  clientId,
  period,
  model,
  aiEnabled,
  status,
  onChanged,
}: {
  clientId: string;
  period: string;
  model: ReportModel;
  aiEnabled: boolean;
  status: string;
  onChanged: () => void;
}) {
  const [headline, setHeadline] = useState(model.executive.headline ?? '');
  const [summary, setSummary] = useState(model.executive.paragraphs.join('\n\n'));
  const [highlights, setHighlights] = useState(model.executive.highlights.join('\n'));
  const [recommendations, setRecommendations] = useState(model.recommendations.join('\n'));
  const [editedBy, setEditedBy] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api.getNarrative(clientId, period).then((d) => setEditedBy(d.edits ? `${d.edits.editedBy} · ${new Date(d.edits.editedAt).toLocaleString()}` : null)).catch(() => {});
  }, [clientId, period]);

  const splitLines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

  async function save() {
    setBusy('save');
    try {
      await api.putNarrative(clientId, period, {
        headline: headline.trim() || undefined,
        summary_paragraphs: summary.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean),
        highlights: splitLines(highlights),
        recommendations: splitLines(recommendations),
      });
      notifications.show({ color: 'teal', message: 'Narrative saved — no AI call needed.' });
      onChanged();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Save failed', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setBusy(null);
    }
  }

  async function regenerate() {
    setBusy('regen');
    try {
      await api.regenerateNarrative(clientId, period);
      notifications.show({
        color: 'teal',
        message: aiEnabled ? 'Cleared — the next load drafts fresh AI text.' : 'Cleared — the offline drafter will rebuild the text.',
      });
      onChanged();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Regenerate failed', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    setBusy('approve');
    try {
      await api.putStatus(clientId, period, 'narrative_approved');
      notifications.show({ color: 'teal', message: 'Narrative approved.' });
      onChanged();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Approve failed', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card withBorder radius="md" padding="lg">
      <Group justify="space-between" mb="sm">
        <Title order={5}>Narrative editor</Title>
        {editedBy && <Badge variant="light" color="yellow">edited · {editedBy}</Badge>}
      </Group>
      <Stack gap="sm">
        <TextInput label="Headline" value={headline} onChange={(e) => setHeadline(e.currentTarget.value)} />
        <Textarea label="Executive summary (blank line between paragraphs)" autosize minRows={4} value={summary} onChange={(e) => setSummary(e.currentTarget.value)} />
        <Textarea label="Highlights (one per line)" autosize minRows={2} value={highlights} onChange={(e) => setHighlights(e.currentTarget.value)} />
        <Textarea label="Recommendations (one per line)" autosize minRows={2} value={recommendations} onChange={(e) => setRecommendations(e.currentTarget.value)} />
        <Group>
          <Button loading={busy === 'save'} onClick={save}>Save narrative</Button>
          <Button variant="default" loading={busy === 'regen'} onClick={regenerate}>
            Regenerate {aiEnabled ? 'with AI' : ''}
          </Button>
          <Button
            variant="light"
            color="teal"
            loading={busy === 'approve'}
            disabled={status === 'narrative_approved'}
            onClick={approve}
          >
            Approve narrative
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          Edits are saved per client/quarter and always win over generated text — no regeneration happens when you tweak wording.
          Regenerate discards edits and the cached draft.
        </Text>
      </Stack>
    </Card>
  );
}

// ── Data review tab ───────────────────────────────────────────────────────────
function DataTab({
  clientId,
  period,
  config,
  setConfig,
  refresh,
  onSaved,
}: {
  clientId: string;
  period: string;
  config: ReportConfig;
  setConfig: (c: ReportConfig) => void;
  refresh: number;
  onSaved: () => void;
}) {
  const [snapshot, setSnapshot] = useState<SnapshotView | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState<MetricRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({ label: '', value: '', unit: '', category: 'security' });

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .getMetrics(clientId, period)
      .then((d) => {
        if (!live) return;
        setSnapshot(d.snapshot);
        setExcluded(new Set(d.excluded));
        setManual(d.snapshot.metrics.filter((m) => m.source === 'manual'));
        setLoadError(null);
      })
      .catch((e) => live && setLoadError(e instanceof Error ? e.message : 'No data'))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [clientId, period, refresh]);

  function addManual() {
    if (!draft.label.trim() || draft.value === '') {
      notifications.show({ color: 'red', message: 'Manual metrics need a label and a value.' });
      return;
    }
    const numeric = Number(draft.value);
    setManual([
      ...manual,
      {
        key: `manual.${draft.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
        label: draft.label.trim(),
        value: Number.isFinite(numeric) && draft.value.trim() !== '' ? numeric : draft.value,
        unit: draft.unit || undefined,
        source: 'manual',
        category: draft.category,
      },
    ]);
    setDraft({ label: '', value: '', unit: '', category: draft.category });
  }

  async function save() {
    setSaving(true);
    try {
      await api.putManualMetrics(clientId, period, manual);
      const nextConfig = { ...config, clientId, excludedMetrics: [...excluded] };
      await api.putConfig(clientId, nextConfig);
      setConfig(nextConfig);
      notifications.show({ color: 'teal', message: 'Data review saved — the report reflects it immediately.' });
      onSaved();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Save failed', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Center h={200}><Loader /></Center>;
  if (loadError || !snapshot) {
    return (
      <Alert color="blue" title="No data pulled yet">
        {loadError ?? 'No snapshot for this quarter.'} Use <b>Sync</b> to pull from the connected tools — everything lands here for review
        before it appears in the QBR. You can also add manual metrics below after the first sync.
      </Alert>
    );
  }

  const collected = snapshot.metrics.filter((m) => m.source !== 'manual');
  const sources = [...new Set(collected.map((m) => m.source))];
  const fmt = (m: MetricRow) => `${m.value === null ? '—' : String(m.value)}${m.unit && m.unit !== 'count' ? ` ${m.unit}` : ''}`;

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          Pulled {new Date(snapshot.capturedAt).toLocaleString()} · {collected.length} metric(s) from {sources.length} source(s).
          Untick anything you don't want in the QBR — the report, scorecard, and AI summary all respect it.
        </Text>
        <Button loading={saving} onClick={save}>Save review</Button>
      </Group>

      {sources.map((source) => (
        <Card key={source} withBorder radius="md" padding="lg">
          <Group mb="sm" gap="xs">
            <Badge variant="light" color="navy">{source}</Badge>
            <Text size="xs" c="dimmed">{collected.filter((m) => m.source === source).length} metric(s)</Text>
          </Group>
          <Table verticalSpacing={6}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={70}>Include</Table.Th>
                <Table.Th>Metric</Table.Th>
                <Table.Th>Value</Table.Th>
                <Table.Th>Category</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {collected
                .filter((m) => m.source === source)
                .map((m) => (
                  <Table.Tr key={m.key} opacity={excluded.has(m.key) ? 0.45 : 1}>
                    <Table.Td>
                      <Checkbox
                        aria-label={`Include ${m.label}`}
                        checked={!excluded.has(m.key)}
                        onChange={(e) => {
                          const next = new Set(excluded);
                          if (e.currentTarget.checked) next.delete(m.key);
                          else next.add(m.key);
                          setExcluded(next);
                        }}
                      />
                    </Table.Td>
                    <Table.Td><Text size="sm">{m.label}</Text></Table.Td>
                    <Table.Td><Text size="sm" fw={600}>{fmt(m)}</Text></Table.Td>
                    <Table.Td><Text size="sm" c="dimmed">{m.category}</Text></Table.Td>
                  </Table.Tr>
                ))}
            </Table.Tbody>
          </Table>
        </Card>
      ))}

      <Card withBorder radius="md" padding="lg">
        <Group mb="sm" gap="xs">
          <Badge variant="light" color="teal">manual</Badge>
          <Text size="xs" c="dimmed">Numbers the APIs can't provide (Synology backups, SAT completion, canaries…)</Text>
        </Group>
        <Stack gap="xs">
          {manual.map((m, i) => (
            <Group key={m.key + i} wrap="nowrap">
              <Text size="sm" style={{ flex: 1 }}>{m.label}</Text>
              <Text size="sm" fw={600}>{fmt(m)}</Text>
              <Text size="sm" c="dimmed">{m.category}</Text>
              <ActionIcon color="red" variant="subtle" aria-label={`Remove ${m.label}`} onClick={() => setManual(manual.filter((_, j) => j !== i))}>
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
          ))}
          <Group align="flex-end" wrap="nowrap">
            <TextInput label="Label" placeholder="Synology backup success" style={{ flex: 1 }} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.currentTarget.value })} />
            <TextInput label="Value" w={110} value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.currentTarget.value })} />
            <TextInput label="Unit" w={90} placeholder="%" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.currentTarget.value })} />
            <Select
              label="Category"
              w={150}
              data={SECTIONS.map(([key]) => key)}
              value={draft.category}
              onChange={(v) => v && setDraft({ ...draft, category: v })}
              allowDeselect={false}
            />
            <Button variant="light" leftSection={<IconPlus size={14} />} onClick={addManual}>Add</Button>
          </Group>
        </Stack>
      </Card>
    </Stack>
  );
}

// ── Attached documents (vendor reports + uploads) ─────────────────────────────
function DocumentsCard({
  clientId,
  period,
  refresh,
  onChanged,
}: {
  clientId: string;
  period: string;
  refresh: number;
  onChanged: () => void;
}) {
  const [docs, setDocs] = useState<DocumentInfo[] | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    let live = true;
    api.listDocuments(clientId, period).then((d) => live && setDocs(d.documents)).catch(() => live && setDocs([]));
    return () => {
      live = false;
    };
  }, [clientId, period, refresh]);

  async function upload(file: File | null) {
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      notifications.show({ color: 'red', message: 'Files up to 15 MB.' });
      return;
    }
    setUploading(true);
    try {
      const dataUri = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read the file.'));
        reader.readAsDataURL(file);
      });
      const dataBase64 = dataUri.split(',')[1] ?? '';
      await api.uploadDocument(clientId, period, { name: file.name, contentType: file.type || 'application/octet-stream', dataBase64 });
      notifications.show({ color: 'teal', message: `${file.name} attached — it's now in the report appendix.` });
      onChanged();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Upload failed', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setUploading(false);
    }
  }

  async function remove(doc: DocumentInfo) {
    try {
      await api.deleteDocument(clientId, period, doc.id);
      notifications.show({ color: 'gray', message: `Removed ${doc.name}.` });
      onChanged();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Delete failed', message: e instanceof Error ? e.message : 'Unknown error' });
    }
  }

  const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  return (
    <Card withBorder radius="md" padding="lg">
      <Group justify="space-between" mb="sm">
        <div>
          <Title order={5}>Attached reports &amp; documents</Title>
          <Text size="xs" c="dimmed">
            Vendor reports (Huntress attaches automatically on Sync) plus anything you upload — Synology exports, Dropsuite summaries,
            invoices. All listed in the report appendix.
          </Text>
        </div>
        <FileButton onChange={upload} accept="application/pdf,image/*,.csv,.xlsx,.docx">
          {(props) => (
            <Button {...props} variant="light" loading={uploading} leftSection={<IconUpload size={16} />}>
              Upload
            </Button>
          )}
        </FileButton>
      </Group>
      {docs === null ? (
        <Center h={60}><Loader size="sm" /></Center>
      ) : docs.length === 0 ? (
        <Text size="sm" c="dimmed">Nothing attached yet.</Text>
      ) : (
        <Table verticalSpacing={6}>
          <Table.Tbody>
            {docs.map((d) => (
              <Table.Tr key={d.id}>
                <Table.Td>
                  <Anchor href={documentUrl(clientId, period, d.id)} size="sm" fw={600}>
                    {d.name}
                  </Anchor>
                </Table.Td>
                <Table.Td><Badge size="sm" variant="light" color={d.source === 'upload' ? 'teal' : 'navy'}>{d.source}</Badge></Table.Td>
                <Table.Td><Text size="xs" c="dimmed">{kb(d.size)}</Text></Table.Td>
                <Table.Td><Text size="xs" c="dimmed">{new Date(d.uploadedAt).toLocaleDateString()}</Text></Table.Td>
                <Table.Td ta="right">
                  <ActionIcon color="red" variant="subtle" aria-label={`Remove ${d.name}`} onClick={() => remove(d)}>
                    <IconTrash size={16} />
                  </ActionIcon>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Card>
  );
}

// ── Meeting tab: pre-wire the agenda, fill it in live, schedule the call ──────
function MeetingTab({
  disc,
  setDisc,
  clientId,
  period,
  meta,
  onChanged,
}: {
  disc: Discussion;
  setDisc: (d: Discussion) => void;
  clientId: string;
  period: string;
  meta: QbrResponse['meta'] | undefined;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [newTopic, setNewTopic] = useState('');

  function addTopic() {
    const topic = newTopic.trim();
    if (!topic) return;
    setDisc({
      ...disc,
      items: [...disc.items, { id: uid(), topic, status: 'planned', includeInReport: true, disposition: 'pending' }],
    });
    setNewTopic('');
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

  async function save() {
    setSaving(true);
    try {
      // Agenda order is the on-screen order.
      const items = disc.items.map((it, i) => ({ ...it, sortOrder: i }));
      await api.putDiscussion(clientId, period, { ...disc, items });
      setDisc({ ...disc, items });
      notifications.show({ color: 'teal', message: 'Agenda saved — answered items flow onto the final report.' });
      onChanged();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Save failed', message: e instanceof Error ? e.message : 'Unknown error' });
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
                  <ActionIcon variant="subtle" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><IconArrowUp size={16} /></ActionIcon>
                  <ActionIcon variant="subtle" aria-label="Move down" disabled={i === disc.items.length - 1} onClick={() => move(i, 1)}><IconArrowDown size={16} /></ActionIcon>
                  <ActionIcon color="red" variant="subtle" aria-label="Remove item" onClick={() => setDisc({ ...disc, items: disc.items.filter((x) => x.id !== it.id) })}><IconTrash size={16} /></ActionIcon>
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
        <Title order={5} mb="md">General notes</Title>
        <Textarea autosize minRows={3} value={disc.notes ?? ''} onChange={(e) => setDisc({ ...disc, notes: e.currentTarget.value })} />
      </Card>

      <ScheduleCard clientId={clientId} period={period} meta={meta} onChanged={onChanged} />
    </Stack>
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
      notifications.show({ color: 'red', title: 'Save failed', message: e instanceof Error ? e.message : 'Unknown error' });
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
          <Select label="Status" data={STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))} value={status} onChange={(v) => v && setStatus(v)} allowDeselect={false} />
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

// ── Actions tab: push dispositioned items with full Halo field control ────────
function ActionsTab({
  clientId,
  period,
  disc,
  onChanged,
}: {
  clientId: string;
  period: string;
  disc: Discussion | null;
  onChanged: () => void;
}) {
  const [pushing, setPushing] = useState<string | null>(null);
  const [ticketItem, setTicketItem] = useState<DiscussionItem | null>(null);

  async function pushSimple(actionId: string, target: string) {
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
    <Stack gap="lg" maw={860}>
      <Card withBorder radius="md" padding="lg">
        <Title order={5} mb="md">Push actions</Title>
        <Text c="dimmed" size="sm" mb="md">
          Turn discussion outcomes into work: Halo tickets open a form where you set the type, agent, team and priority before pushing.
        </Text>
        {items.length === 0 ? (
          <Text size="sm" c="dimmed">No discussion items — capture them on the Meeting tab first.</Text>
        ) : (
          <Stack>
            {items.map((it) => (
              <Fieldset key={it.id} p="sm">
                <Group justify="space-between" align="flex-start">
                  <div style={{ flex: 1 }}>
                    <Text fw={600} size="sm">{it.topic || '(untitled)'}</Text>
                    {it.response && <Text size="xs" c="dimmed" lineClamp={2}>{it.response}</Text>}
                  </div>
                  {it.externalRef && (
                    <Badge color="green" variant="light">
                      {it.externalRef.system} #{it.externalRef.id}
                      {it.externalRef.status ? ` · ${it.externalRef.status}` : ''}
                    </Badge>
                  )}
                </Group>
                <Divider my="xs" />
                <Group gap="xs">
                  <Button size="xs" variant="light" leftSection={<IconTicket size={14} />} onClick={() => setTicketItem(it)}>
                    Halo ticket…
                  </Button>
                  <Button
                    size="xs"
                    variant="light"
                    color="teal"
                    leftSection={<IconTargetArrow size={14} />}
                    loading={pushing === it.id + 'halo_opportunity'}
                    onClick={() => pushSimple(it.id, 'halo_opportunity')}
                  >
                    Halo opportunity
                  </Button>
                  <Button
                    size="xs"
                    variant="light"
                    color="grape"
                    leftSection={<IconTargetArrow size={14} />}
                    loading={pushing === it.id + 'zomentum_opportunity'}
                    onClick={() => pushSimple(it.id, 'zomentum_opportunity')}
                  >
                    Zomentum opportunity
                  </Button>
                </Group>
              </Fieldset>
            ))}
          </Stack>
        )}
      </Card>

      {ticketItem && (
        <HaloTicketModal
          item={ticketItem}
          clientId={clientId}
          period={period}
          onClose={() => setTicketItem(null)}
          onPushed={() => {
            setTicketItem(null);
            onChanged();
          }}
        />
      )}
    </Stack>
  );
}

/** Halo ticket push with full field control — type, agent, team, priority. */
function HaloTicketModal({
  item,
  clientId,
  period,
  onClose,
  onPushed,
}: {
  item: DiscussionItem;
  clientId: string;
  period: string;
  onClose: () => void;
  onPushed: () => void;
}) {
  const [meta, setMeta] = useState<HaloMeta | null>(null);
  const [metaNote, setMetaNote] = useState<string | null>(null);
  const [summary, setSummary] = useState(item.topic);
  const [details, setDetails] = useState(item.response ?? '');
  const [ticketTypeId, setTicketTypeId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [team, setTeam] = useState<string | null>(null);
  const [priorityId, setPriorityId] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .haloMeta()
      .then((m) => live && setMeta(m))
      .catch((e) => live && setMetaNote(e instanceof Error ? e.message : 'Halo lookup lists unavailable — the ticket still pushes with summary + details.'));
    return () => {
      live = false;
    };
  }, []);

  async function push() {
    if (!summary.trim()) {
      notifications.show({ color: 'red', message: 'A summary is required.' });
      return;
    }
    setPushing(true);
    try {
      const r = await api.pushAction(clientId, period, {
        actionId: item.id,
        target: 'halo_ticket',
        title: summary.trim(),
        detail: details,
        ticketTypeId: ticketTypeId ?? undefined,
        agentId: agentId ?? undefined,
        team: team ?? undefined,
        priorityId: priorityId ?? undefined,
      });
      notifications.show({ color: 'teal', title: 'Ticket created', message: `Halo #${r.id}${r.status ? ` · ${r.status}` : ''}` });
      onPushed();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Push failed', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setPushing(false);
    }
  }

  const opts = (rows: Array<{ id: string; name: string }> | undefined) => (rows ?? []).map((r) => ({ value: r.id, label: r.name }));

  return (
    <Modal opened onClose={onClose} title="Create Halo ticket" size="lg">
      <Stack>
        <TextInput label="Summary" required value={summary} onChange={(e) => setSummary(e.currentTarget.value)} />
        <Textarea label="Details" autosize minRows={3} value={details} onChange={(e) => setDetails(e.currentTarget.value)} />
        {metaNote && <Text size="xs" c="dimmed">{metaNote}</Text>}
        <Group grow>
          <Select
            label="Ticket type"
            placeholder={meta ? 'Default' : 'Loading…'}
            data={opts(meta?.ticketTypes)}
            value={ticketTypeId}
            onChange={setTicketTypeId}
            searchable
            clearable
          />
          <Select
            label="Priority"
            placeholder={meta ? 'Default' : 'Loading…'}
            data={opts(meta?.priorities)}
            value={priorityId}
            onChange={setPriorityId}
            clearable
          />
        </Group>
        <Group grow>
          <Select
            label="Assign to agent"
            placeholder={meta ? 'Unassigned' : 'Loading…'}
            data={opts(meta?.agents)}
            value={agentId}
            onChange={setAgentId}
            searchable
            clearable
          />
          <Select
            label="Team"
            placeholder={meta ? 'Default' : 'Loading…'}
            data={(meta?.teams ?? []).map((t) => ({ value: t.name, label: t.name }))}
            value={team}
            onChange={setTeam}
            searchable
            clearable
          />
        </Group>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button loading={pushing} leftSection={<IconTicket size={16} />} onClick={push}>Create ticket</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ── Studio tab: shape the report (branding + sections) ────────────────────────
function StudioTab({
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
      notifications.show({ color: 'teal', message: 'Saved. The report reflects it instantly — AI text is reused.' });
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
        <Title order={5} mb={4}>Client branding</Title>
        <Text size="xs" c="dimmed" mb="md">
          The Mash IT logo and colors come from Settings; anything set here layers on top for this client. The client logo shows
          alongside the Mash IT logo on the report, PDF and deck.
        </Text>
        <Stack>
          <TextInput label="Brand name override" value={brand.name ?? ''} onChange={(e) => setConfig({ ...config, brand: { ...brand, name: e.currentTarget.value } })} />
          <Group grow>
            <ColorInput label="Primary color" value={brand.primary ?? ''} placeholder="from Settings" onChange={(v) => setConfig({ ...config, brand: { ...brand, primary: v } })} />
            <ColorInput label="Accent color" value={brand.accent ?? ''} placeholder="from Settings" onChange={(v) => setConfig({ ...config, brand: { ...brand, accent: v } })} />
          </Group>
          <Group align="flex-end">
            <FileButton accept="image/*" onChange={onLogo}>
              {(props) => <Button variant="default" {...props}>Upload client logo</Button>}
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
                <ActionIcon color="red" variant="subtle" aria-label="Remove section" onClick={() => setConfig({ ...config, customSections: (config.customSections ?? []).filter((x) => x.id !== s.id) })}><IconTrash size={16} /></ActionIcon>
              </Group>
              <Textarea autosize minRows={2} placeholder="Body" value={s.body} onChange={(e) => { const cs = [...(config.customSections ?? [])]; cs[i] = { ...s, body: e.currentTarget.value }; setConfig({ ...config, customSections: cs }); }} />
            </Fieldset>
          ))}
        </Stack>
      </Card>

      <Group><Button loading={saving} onClick={save}>Save</Button></Group>
    </Stack>
  );
}
