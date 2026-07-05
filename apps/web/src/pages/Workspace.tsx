import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
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
  Checkbox,
  Fieldset,
  Autocomplete,
  ActionIcon,
  Badge,
  FileButton,
  Image,
  Divider,
  Tooltip,
  Table,
  Progress,
  Modal,
  Anchor,
  SegmentedControl,
  CopyButton,
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
  IconBulb,
  IconDownload,
  IconExternalLink,
  IconSparkles,
  IconTableImport,
} from '@tabler/icons-react';
import { api, documentUrl, reportUrls } from '../api.js';
import { lastPeriods } from '../periods.js';
import type {
  Client,
  Discussion,
  DiscussionItem,
  DocExtraction,
  DocMatchSuggestion,
  DocumentInfo,
  HaloMeta,
  MetricRow,
  Opportunity,
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
const DOC_CATEGORIES = ['Security', 'Backup', 'Endpoint', 'Email', 'Network', 'Compliance', 'Billing', 'Other'];
const RING_COLOR: Record<string, string> = { green: 'teal', amber: 'yellow', red: 'red', unknown: 'gray' };

/** Download a metric's drill-down rows as a CSV (client-side, no round trip). */
function exportDetailsCsv(m: MetricRow) {
  const rows = m.details ?? [];
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]!);
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${m.key.replace(/[^a-z0-9.-]+/gi, '_')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

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
  const [tab, setTab] = useState<string>('overview');
  // Unsaved-work guards: a refresh must not clobber a mid-meeting agenda, and
  // leaving the Data tab with staged review changes should ask first.
  const discDirty = useRef(false);
  const dataDirty = useRef(false);
  const discKey = useRef('');

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
    // Switching client/quarter always reloads the discussion; a plain refresh
    // (Sync, saves elsewhere) must NOT overwrite answers typed mid-meeting.
    if (discKey.current !== `${clientId}/${period}`) {
      discKey.current = `${clientId}/${period}`;
      discDirty.current = false;
    }
    api
      .getDiscussion(clientId, period)
      .then((d) => live && !discDirty.current && setDisc(d))
      .catch(() => live && !discDirty.current && setDisc({ clientId, period, items: [] }));
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

      <Tabs
        value={tab}
        keepMounted={false}
        onChange={(v) => {
          if (!v) return;
          if (tab === 'data' && dataDirty.current && !window.confirm('You have unsaved data-review changes. Leave the Data tab and discard them?')) {
            return;
          }
          if (tab === 'data') dataDirty.current = false;
          setTab(v);
        }}
      >
        <Tabs.List mb="md">
          <Tabs.Tab value="overview">Overview</Tabs.Tab>
          <Tabs.Tab value="data">Data</Tabs.Tab>
          <Tabs.Tab value="reports">Reports</Tabs.Tab>
          <Tabs.Tab value="meeting">Meeting</Tabs.Tab>
          <Tabs.Tab value="actions">Actions</Tabs.Tab>
          <Tabs.Tab value="board">Opportunities</Tabs.Tab>
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
              config={config}
              setConfig={setConfig}
              onChanged={() => setRefresh((n) => n + 1)}
            />
          ) : (
            <Text c="dimmed">No report.</Text>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="data">
          {period && config && (
            <Stack gap="lg" maw={900}>
              <DataTab
                clientId={clientId}
                period={period}
                config={config}
                setConfig={setConfig}
                refresh={refresh}
                onDirty={(d) => (dataDirty.current = d)}
                onSaved={() => setRefresh((n) => n + 1)}
              />
            </Stack>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="reports">
          {period && (
            <ReportsTab
              clientId={clientId}
              period={period}
              periods={periods}
              refresh={refresh}
              reportsMailbox={system?.reportsMailbox ?? null}
              aiEnabled={system?.ai ?? false}
              onChanged={() => setRefresh((n) => n + 1)}
            />
          )}
        </Tabs.Panel>

        <Tabs.Panel value="meeting">
          {disc && (
            <MeetingTab
              disc={disc}
              setDisc={(d) => {
                discDirty.current = true;
                setDisc(d);
              }}
              clientId={clientId}
              period={period}
              meta={meta}
              onSavedDiscussion={() => (discDirty.current = false)}
              onChanged={() => setRefresh((n) => n + 1)}
            />
          )}
        </Tabs.Panel>

        <Tabs.Panel value="actions">
          <ActionsTab clientId={clientId} period={period} disc={disc} onChanged={() => setRefresh((n) => n + 1)} />
        </Tabs.Panel>

        <Tabs.Panel value="board">
          <OpportunitiesTab clientId={clientId} period={period} />
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
  config,
  setConfig,
  onChanged,
}: {
  qbr: QbrResponse;
  clientId: string;
  period: string;
  refresh: number;
  aiEnabled: boolean;
  config: ReportConfig | null;
  setConfig: (c: ReportConfig) => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [docs, setDocs] = useState<DocumentInfo[]>([]);
  const { model } = qbr;
  const score = model.scorecard.overall.score ?? 0;
  // Unmeasured functions (score null) must not render as 0 — with sparse data
  // a radar collapses into misleading spikes, so fall back to bars.
  const measuredFns = useMemo(() => model.scorecard.functions.filter((f) => f.score !== null), [model.scorecard.functions]);
  const unmeasuredFns = useMemo(() => model.scorecard.functions.filter((f) => f.score === null), [model.scorecard.functions]);
  const radar = useMemo(() => measuredFns.map((f) => ({ function: f.function, score: f.score ?? 0 })), [measuredFns]);
  const ringSections = useMemo(
    () => [{ value: score, color: RING_COLOR[model.scorecard.overall.rating] ?? 'gray' }],
    [score, model.scorecard.overall.rating],
  );
  const trendData = useMemo(
    () =>
      model.trends
        .filter((t) => t.current !== null && (t.category === 'operations' || t.category === 'security') && !/siem|logs|events|signals/i.test(t.key))
        .slice(0, 6)
        .map((t) => ({
          label: t.label.length > 14 ? t.label.slice(0, 13) + '…' : t.label,
          previous: t.previous ?? 0,
          current: t.current ?? 0,
        })),
    [model.trends],
  );
  // High-level spend picture for the client-facing overview. Quarterly
  // invoiced categories only — mixing monthly recurring amounts onto the same
  // axis would compare different measures.
  const spendData = useMemo(() => {
    const invoiced = model.trends.filter((t) => t.current !== null && t.key.startsWith('finance.invoiced.'));
    const rows = invoiced.length > 0 ? invoiced : model.trends.filter((t) => t.current !== null && t.key.startsWith('finance.recurring.'));
    return rows
      .map((t) => ({
        label: (t.label.length > 20 ? t.label.slice(0, 19) + '…' : t.label).replace(/\s+/g, ' '),
        amount: t.current ?? 0,
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 6);
  }, [model.trends]);
  const spendIsRecurring = useMemo(() => !model.trends.some((t) => t.key.startsWith('finance.invoiced.')), [model.trends]);

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
          config={config}
          setConfig={setConfig}
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
              sections={ringSections}
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
          {measuredFns.length >= 3 ? (
            <RadarChart h={230} data={radar} dataKey="function" withPolarRadiusAxis series={[{ name: 'score', color: 'teal.7', opacity: 0.35 }]} />
          ) : measuredFns.length > 0 ? (
            <Stack gap="sm">
              {measuredFns.map((f) => (
                <div key={f.function}>
                  <Group justify="space-between" mb={2}>
                    <Text size="sm" fw={600}>{f.function}</Text>
                    <Text size="sm" c="dimmed">{Math.round(f.score ?? 0)} / 100</Text>
                  </Group>
                  <Progress value={f.score ?? 0} color={RING_COLOR[f.rating] ?? 'teal'} size="md" radius="sm" />
                </div>
              ))}
            </Stack>
          ) : (
            <Text size="sm" c="dimmed">No function scores available yet — run a Sync with mapped tools.</Text>
          )}
          {measuredFns.length > 0 && unmeasuredFns.length > 0 && (
            <Text size="xs" c="dimmed" mt="sm">
              Not yet measured: {unmeasuredFns.map((f) => f.function).join(', ')} — connect more tools to light these up.
            </Text>
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

      {spendData.length > 0 && (
        <Card withBorder radius="md" padding="lg">
          <Title order={5} mb={2}>{spendIsRecurring ? 'Monthly recurring breakdown' : 'IT spend breakdown'}</Title>
          <Text size="xs" c="dimmed" mb="md">{spendIsRecurring ? 'Composition of the monthly bill.' : 'Invoiced this quarter, by category.'}</Text>
          <BarChart
            h={spendData.length * 44 + 40}
            data={spendData}
            dataKey="label"
            orientation="vertical"
            series={[{ name: 'amount', label: 'USD', color: 'navy.6' }]}
            valueFormatter={(v) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
            barProps={{ maxBarSize: 22, radius: [0, 4, 4, 0] }}
            gridAxis="x"
            withTooltip
            yAxisProps={{ width: 150, tickLine: false }}
            xAxisProps={{ tickLine: false }}
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
const FOCUS_OPTIONS = [
  'Business security',
  'Business continuity',
  'Infrastructure & lifecycle',
  'Cost optimization',
  'Compliance readiness',
  'Service experience',
];

function NarrativeEditor({
  clientId,
  period,
  model,
  aiEnabled,
  status,
  config,
  setConfig,
  onChanged,
}: {
  clientId: string;
  period: string;
  model: ReportModel;
  aiEnabled: boolean;
  status: string;
  config: ReportConfig | null;
  setConfig: (c: ReportConfig) => void;
  onChanged: () => void;
}) {
  const [headline, setHeadline] = useState(model.executive.headline ?? '');
  const [summary, setSummary] = useState(model.executive.paragraphs.join('\n\n'));
  const [highlights, setHighlights] = useState(model.executive.highlights.join('\n'));
  const [recommendations, setRecommendations] = useState(model.recommendations.join('\n'));
  const [editedBy, setEditedBy] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // AI direction (persisted in the report config; changing it re-drafts).
  const [focus, setFocus] = useState(config?.narrativeFocus ?? '');
  const [guidance, setGuidance] = useState(config?.narrativeGuidance ?? '');
  const [sectionNotes, setSectionNotes] = useState<Record<string, string>>(config?.sectionGuidance ?? {});
  const [openSection, setOpenSection] = useState<string | null>(null);

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

  /**
   * Persist focus/guidance/section comments into the report config, then clear
   * the cached draft so the next build re-drafts with the direction included.
   */
  async function applyDirection(notes: Record<string, string>, busyKey: string) {
    setBusy(busyKey);
    try {
      const cleanNotes = Object.fromEntries(Object.entries(notes).filter(([, v]) => v.trim() !== ''));
      const next: ReportConfig = {
        ...(config ?? { clientId }),
        clientId,
        narrativeFocus: focus.trim() || undefined,
        narrativeGuidance: guidance.trim() || undefined,
        sectionGuidance: Object.keys(cleanNotes).length ? cleanNotes : undefined,
      };
      await api.putConfig(clientId, next);
      setConfig(next);
      await api.regenerateNarrative(clientId, period);
      notifications.show({
        color: 'teal',
        message: aiEnabled ? 'Direction saved — regenerating the narrative with it.' : 'Direction saved (connect the AI key to use it).',
      });
      onChanged();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Could not apply direction', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setBusy(null);
    }
  }

  const sections = model.sections ?? [];

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

        <Divider label="AI direction" labelPosition="left" mt="xs" />
        <Group grow align="flex-start">
          <Autocomplete
            label="QBR focus"
            description="The theme this QBR should emphasize — pick one or type your own."
            placeholder="e.g. Business security"
            data={FOCUS_OPTIONS}
            value={focus}
            onChange={setFocus}
          />
        </Group>
        <Textarea
          label="Guidance for the AI"
          description="Standing instruction applied every time the narrative is drafted (e.g. “backup counts changed because we re-tuned monitoring — do not present that as a trend”)."
          autosize
          minRows={2}
          value={guidance}
          onChange={(e) => setGuidance(e.currentTarget.value)}
        />
        <Group>
          <Button
            variant="light"
            leftSection={<IconSparkles size={16} />}
            loading={busy === 'direction'}
            onClick={() => applyDirection(sectionNotes, 'direction')}
          >
            Save direction &amp; regenerate
          </Button>
        </Group>

        {sections.length > 0 && (
          <>
            <Divider label="Section summaries" labelPosition="left" mt="xs" />
            <Stack gap="xs">
              {sections.map((s) => (
                <div key={s.category}>
                  <Group gap="xs" wrap="nowrap" align="flex-start">
                    <div style={{ flex: 1 }}>
                      <Text size="sm" fw={600}>{s.title}</Text>
                      <Text size="xs" c="dimmed">{s.summary ?? 'No summary drafted for this section yet.'}</Text>
                    </div>
                    <Tooltip label="Comment on this section and regenerate">
                      <ActionIcon
                        variant={openSection === s.category || sectionNotes[s.category] ? 'light' : 'subtle'}
                        color="teal"
                        aria-label={`Adjust ${s.title} summary`}
                        onClick={() => setOpenSection(openSection === s.category ? null : s.category)}
                      >
                        <IconPencil size={15} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                  {openSection === s.category && (
                    <Group mt={6} gap="xs" align="flex-start" wrap="nowrap">
                      <Textarea
                        style={{ flex: 1 }}
                        autosize
                        minRows={1}
                        placeholder="What should change in this section? (e.g. “don't call the backup drop a decline — we re-tuned what we measure”)"
                        value={sectionNotes[s.category] ?? ''}
                        onChange={(e) => setSectionNotes({ ...sectionNotes, [s.category]: e.currentTarget.value })}
                      />
                      <Button
                        size="xs"
                        variant="light"
                        loading={busy === `section:${s.category}`}
                        onClick={() => applyDirection(sectionNotes, `section:${s.category}`)}
                      >
                        Regenerate
                      </Button>
                    </Group>
                  )}
                </div>
              ))}
            </Stack>
            <Text size="xs" c="dimmed">
              Section comments are remembered and applied on every regenerate — clear a comment and regenerate to drop it.
            </Text>
          </>
        )}
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
  onDirty,
  onSaved,
}: {
  clientId: string;
  period: string;
  config: ReportConfig;
  setConfig: (c: ReportConfig) => void;
  refresh: number;
  /** Reports staged-but-unsaved review changes so the parent can guard tab switches. */
  onDirty?: (dirty: boolean) => void;
  onSaved: () => void;
}) {
  const [snapshot, setSnapshot] = useState<SnapshotView | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState<MetricRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({ label: '', value: '', unit: '', category: 'security' });
  // The metric whose backing rows (tickets, invoice lines, devices…) are open.
  const [detail, setDetail] = useState<MetricRow | null>(null);

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
        onDirty?.(false);
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
    onDirty?.(true);
  }

  async function save() {
    setSaving(true);
    try {
      await api.putManualMetrics(clientId, period, manual);
      const nextConfig = { ...config, clientId, excludedMetrics: [...excluded] };
      await api.putConfig(clientId, nextConfig);
      setConfig(nextConfig);
      notifications.show({ color: 'teal', message: 'Data review saved — the report reflects it immediately.' });
      onDirty?.(false);
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
                          onDirty?.(true);
                        }}
                      />
                    </Table.Td>
                    <Table.Td><Text size="sm">{m.label}</Text></Table.Td>
                    <Table.Td>
                      {m.details?.length ? (
                        <Tooltip label={`View the ${m.details.length} row(s) behind this number`}>
                          <Anchor component="button" type="button" size="sm" fw={600} onClick={() => setDetail(m)}>
                            {fmt(m)}
                          </Anchor>
                        </Tooltip>
                      ) : (
                        <Text size="sm" fw={600}>{fmt(m)}</Text>
                      )}
                    </Table.Td>
                    <Table.Td><Text size="sm" c="dimmed">{m.category}</Text></Table.Td>
                  </Table.Tr>
                ))}
            </Table.Tbody>
          </Table>
        </Card>
      ))}

      <Modal
        opened={detail !== null}
        onClose={() => setDetail(null)}
        title={detail ? `${detail.label} — ${detail.details?.length ?? 0} row(s)` : ''}
        size="xl"
      >
        {detail?.details?.length ? (
          <>
            <Group justify="flex-end" mb="xs">
              <Button size="compact-xs" variant="light" leftSection={<IconDownload size={14} />} onClick={() => exportDetailsCsv(detail)}>
                Export CSV
              </Button>
            </Group>
            <Table.ScrollContainer minWidth={520}>
              <Table striped verticalSpacing={4} stickyHeader>
                <Table.Thead>
                  <Table.Tr>
                    {Object.keys(detail.details[0]!).filter((k) => k !== 'url').map((k) => (
                      <Table.Th key={k} tt="capitalize">{k}</Table.Th>
                    ))}
                    {detail.details.some((r) => typeof r['url'] === 'string' && r['url']) && <Table.Th w={40} />}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {detail.details.map((row, i) => (
                    <Table.Tr key={i}>
                      {Object.keys(detail.details![0]!).filter((k) => k !== 'url').map((k) => (
                        <Table.Td key={k}>
                          <Text size="sm">{String(row[k] ?? '')}</Text>
                        </Table.Td>
                      ))}
                      {detail.details!.some((r) => typeof r['url'] === 'string' && r['url']) && (
                        <Table.Td>
                          {typeof row['url'] === 'string' && row['url'] && (
                            <Tooltip label="Open in the source tool">
                              <ActionIcon component="a" href={row['url']} target="_blank" variant="subtle" size="sm" aria-label="Open in source tool">
                                <IconExternalLink size={14} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                        </Table.Td>
                      )}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </>
        ) : null}
        {typeof detail?.value === 'number' && (detail.details?.length ?? 0) < detail.value && (
          <Text size="xs" c="dimmed" mt="xs">
            Showing the first {detail.details?.length} of {detail.value} — the full set lives in the source tool.
          </Text>
        )}
      </Modal>

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
              <ActionIcon color="red" variant="subtle" aria-label={`Remove ${m.label}`} onClick={() => { setManual(manual.filter((_, j) => j !== i)); onDirty?.(true); }}>
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
function ReportsTab({
  clientId,
  period,
  periods,
  refresh,
  reportsMailbox,
  aiEnabled,
  onChanged,
}: {
  clientId: string;
  period: string;
  periods: Array<{ value: string; label: string }>;
  refresh: number;
  reportsMailbox: string | null;
  aiEnabled: boolean;
  onChanged: () => void;
}) {
  const [docs, setDocs] = useState<DocumentInfo[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [renaming, setRenaming] = useState<DocumentInfo | null>(null);
  const [newName, setNewName] = useState('');
  // AI matcher state, keyed by period:id (docs can move between quarters).
  const [ai, setAi] = useState<Record<string, { loading?: boolean; suggestion?: DocMatchSuggestion }>>({});
  const [bulkMatching, setBulkMatching] = useState(false);
  // Multi-select for bulk delete + the AI metric-extraction review modal.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [extracting, setExtracting] = useState<string | null>(null);
  const [review, setReview] = useState<{ doc: DocumentInfo; extraction: DocExtraction; source: string; checked: Set<number> } | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    let live = true;
    api.listClientDocuments(clientId).then((d) => live && setDocs(d.documents)).catch(() => live && setDocs([]));
    return () => {
      live = false;
    };
  }, [clientId, refresh]);

  const reload = () => api.listClientDocuments(clientId).then((d) => setDocs(d.documents)).catch(() => {});

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
      notifications.show({ color: 'teal', message: `${file.name} filed under ${period}.` });
      await reload();
      onChanged();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Upload failed', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setUploading(false);
    }
  }

  async function patch(doc: DocumentInfo, body: { name?: string; category?: string; period?: string }, note: string) {
    try {
      await api.updateDocument(clientId, doc.period, doc.id, body);
      notifications.show({ color: 'teal', message: note });
      await reload();
      onChanged();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Update failed', message: e instanceof Error ? e.message : 'Unknown error' });
    }
  }

  async function remove(doc: DocumentInfo) {
    if (!window.confirm(`Permanently delete “${doc.name}”? It also disappears from the ${doc.period} report appendix.`)) return;
    try {
      await api.deleteDocument(clientId, doc.period, doc.id);
      notifications.show({ color: 'gray', message: `Removed ${doc.name}.` });
      await reload();
      onChanged();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Delete failed', message: e instanceof Error ? e.message : 'Unknown error' });
    }
  }

  const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const periodValues = periods.map((p) => ({ value: p.value, label: p.value }));
  const inboxAddress = reportsMailbox ? reportsMailbox.replace('@', `+${clientId}@`) : null;

  const isPdf = (d: DocumentInfo) => d.contentType.includes('pdf') || /\.pdf$/i.test(d.name);
  const aiKey = (d: DocumentInfo) => `${d.period}:${d.id}`;

  async function analyze(d: DocumentInfo): Promise<void> {
    const key = aiKey(d);
    setAi((a) => ({ ...a, [key]: { ...a[key], loading: true } }));
    try {
      const { suggestion } = await api.matchDocument(clientId, d.period, d.id);
      setAi((a) => ({ ...a, [key]: { suggestion } }));
    } catch (e) {
      setAi((a) => ({ ...a, [key]: {} }));
      notifications.show({ color: 'red', title: `AI match failed for ${d.name}`, message: e instanceof Error ? e.message : 'Unknown error' });
    }
  }

  /** Analyze every PDF that doesn't have a suggestion yet (sequential — each is a model call). */
  async function analyzeAll() {
    setBulkMatching(true);
    try {
      for (const d of (docs ?? []).filter(isPdf).filter((d) => !ai[aiKey(d)]?.suggestion)) await analyze(d);
    } finally {
      setBulkMatching(false);
    }
  }

  async function acceptMatch(d: DocumentInfo, s: DocMatchSuggestion) {
    await patch(
      d,
      { name: s.suggestedName, period: s.suggestedPeriod, category: s.suggestedCategory },
      `Filed as “${s.suggestedName}” under ${s.suggestedPeriod} (${s.suggestedCategory}).`,
    );
    dismissMatch(d);
  }

  function dismissMatch(d: DocumentInfo) {
    setAi((a) => {
      const next = { ...a };
      delete next[aiKey(d)];
      return next;
    });
  }

  /** AI metric extraction: read the PDF, then review before importing. */
  async function extract(d: DocumentInfo) {
    setExtracting(aiKey(d));
    try {
      const { extraction, source } = await api.extractDocument(clientId, d.period, d.id);
      if (extraction.metrics.length === 0) {
        notifications.show({ color: 'yellow', message: `No importable metrics found in ${d.name}.` });
      } else {
        setReview({ doc: d, extraction, source, checked: new Set(extraction.metrics.map((_, i) => i)) });
      }
    } catch (e) {
      notifications.show({ color: 'red', title: `Extraction failed for ${d.name}`, message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setExtracting(null);
    }
  }

  async function importReviewed() {
    if (!review) return;
    setImporting(true);
    try {
      const metrics = review.extraction.metrics.filter((_, i) => review.checked.has(i));
      const r = await api.importDocMetrics(clientId, review.doc.period, { source: review.source, metrics });
      notifications.show({ color: 'teal', message: `${r.imported} metric(s) added to ${review.doc.period} — review them on the Data tab.` });
      setReview(null);
      onChanged();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Import failed', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setImporting(false);
    }
  }

  async function removeSelected() {
    const chosen = (docs ?? []).filter((d) => selected.has(aiKey(d)));
    if (chosen.length === 0) return;
    if (!window.confirm(`Permanently delete ${chosen.length} report(s)? They also disappear from their quarters' appendices.`)) return;
    setBulkDeleting(true);
    let failed = 0;
    for (const d of chosen) {
      try {
        await api.deleteDocument(clientId, d.period, d.id);
      } catch {
        failed++;
      }
    }
    setBulkDeleting(false);
    setSelected(new Set());
    notifications.show({
      color: failed ? 'yellow' : 'gray',
      message: failed ? `Deleted ${chosen.length - failed} report(s); ${failed} failed.` : `Deleted ${chosen.length} report(s).`,
    });
    await reload();
    onChanged();
  }

  function toggleSelected(key: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  return (
    <Stack gap="lg">
      <Card withBorder radius="md" padding="lg">
        <Group justify="space-between" mb="sm">
          <div>
            <Title order={5}>Report repository</Title>
            <Text size="xs" c="dimmed">
              Every vendor report and upload for this client, across all quarters — Huntress attaches on Sync, the report inbox
              files what you forward, and uploads land in the selected quarter ({period}). Rename, categorize, or move anything
              filed to the wrong quarter — or let <b>AI match</b> read each PDF and suggest all three, then accept with one click.
              The <b>table-import</b> button reads a PDF's numbers into that quarter's data (great for Check Point checkups and for
              ingesting a previous QBR so trends have history). PDFs are appended to that quarter's QBR PDF and ride on its email draft.
            </Text>
          </div>
          <Group gap="xs">
            {aiEnabled && (docs ?? []).some(isPdf) && (
              <Tooltip label="The AI reads each PDF and suggests the vendor, a clean name, the quarter its content covers, and a category — you accept each match with one click.">
                <Button variant="light" color="teal" loading={bulkMatching} leftSection={<IconSparkles size={16} />} onClick={analyzeAll}>
                  AI match PDFs
                </Button>
              </Tooltip>
            )}
            <FileButton onChange={upload} accept="application/pdf,image/*,.csv,.xlsx,.docx">
              {(props) => (
                <Button {...props} variant="light" loading={uploading} leftSection={<IconUpload size={16} />}>
                  Upload to {period}
                </Button>
              )}
            </FileButton>
          </Group>
        </Group>
        {inboxAddress ? (
          <Alert color="teal" variant="light" p="xs">
            <Group gap="xs" wrap="nowrap" align="flex-start">
              <Text size="xs" style={{ flex: 1 }}>
                This client's report inbox:{' '}
                <Text span fw={700} style={{ userSelect: 'all' }}>{inboxAddress}</Text>
                {' '}— schedule vendor reports to send here, or forward them yourself (checked every 5 minutes). No quarter tag in
                the subject = the current quarter; add one like “2026-Q2” to aim at a specific QBR.
              </Text>
              <CopyButton value={inboxAddress}>
                {({ copied, copy }) => (
                  <Button size="compact-xs" variant={copied ? 'filled' : 'light'} color="teal" onClick={copy}>
                    {copied ? 'Copied' : 'Copy address'}
                  </Button>
                )}
              </CopyButton>
            </Group>
          </Alert>
        ) : (
          <Alert color="gray" variant="light" p="xs">
            <Text size="xs">
              <b>Report inbox not set up yet.</b> Once configured, this client gets its own email address to receive scheduled
              vendor reports. The 3-step setup is on the <Anchor component={RouterLink} to="/settings" size="xs">Settings page</Anchor>.
            </Text>
          </Alert>
        )}
      </Card>

      <Card withBorder radius="md" padding="lg">
        {docs === null ? (
          <Center h={60}><Loader size="sm" /></Center>
        ) : docs.length === 0 ? (
          <Text size="sm" c="dimmed">Nothing filed yet.</Text>
        ) : (
          <Table.ScrollContainer minWidth={860}>
            <Table verticalSpacing={6}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={36}>
                    <Checkbox
                      size="xs"
                      aria-label="Select all reports"
                      checked={docs.length > 0 && selected.size === docs.length}
                      indeterminate={selected.size > 0 && selected.size < docs.length}
                      onChange={(e) => setSelected(e.currentTarget.checked ? new Set(docs.map(aiKey)) : new Set())}
                    />
                  </Table.Th>
                  <Table.Th>Report</Table.Th>
                  <Table.Th w={130}>Category</Table.Th>
                  <Table.Th w={110}>Quarter</Table.Th>
                  <Table.Th>Source</Table.Th>
                  <Table.Th>Size</Table.Th>
                  <Table.Th>Filed</Table.Th>
                  <Table.Th w={110}>
                    {selected.size > 0 && (
                      <Button size="compact-xs" color="red" variant="light" loading={bulkDeleting} onClick={removeSelected}>
                        Delete {selected.size}
                      </Button>
                    )}
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {docs.map((d) => (
                  <Fragment key={`${d.period}-${d.id}`}>
                  <Table.Tr>
                    <Table.Td>
                      <Checkbox
                        size="xs"
                        aria-label={`Select ${d.name}`}
                        checked={selected.has(aiKey(d))}
                        onChange={(e) => toggleSelected(aiKey(d), e.currentTarget.checked)}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Anchor href={documentUrl(clientId, d.period, d.id)} size="sm" fw={600}>
                        {d.name}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>
                      <Select
                        size="xs"
                        placeholder="—"
                        data={DOC_CATEGORIES}
                        value={d.category ?? null}
                        onChange={(v) => patch(d, { category: v ?? '' }, v ? `Categorized as ${v}.` : 'Category cleared.')}
                        clearable
                        aria-label={`Category for ${d.name}`}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Select
                        size="xs"
                        data={periodValues.some((p) => p.value === d.period) ? periodValues : [{ value: d.period, label: d.period }, ...periodValues]}
                        value={d.period}
                        onChange={(v) => v && v !== d.period && patch(d, { period: v }, `Moved to ${v}.`)}
                        allowDeselect={false}
                        aria-label={`Quarter for ${d.name}`}
                      />
                    </Table.Td>
                    <Table.Td><Badge size="sm" variant="light" color={d.source === 'upload' ? 'teal' : d.source === 'email' ? 'grape' : 'navy'}>{d.source}</Badge></Table.Td>
                    <Table.Td><Text size="xs" c="dimmed">{kb(d.size)}</Text></Table.Td>
                    <Table.Td><Text size="xs" c="dimmed">{new Date(d.uploadedAt).toLocaleDateString()}</Text></Table.Td>
                    <Table.Td>
                      <Group gap={2} wrap="nowrap" justify="flex-end">
                        {aiEnabled && isPdf(d) && (
                          <Tooltip label="AI match: read the PDF and suggest name / quarter / category">
                            <ActionIcon
                              variant="subtle"
                              color="teal"
                              aria-label={`AI match ${d.name}`}
                              loading={ai[aiKey(d)]?.loading}
                              onClick={() => analyze(d)}
                            >
                              <IconSparkles size={15} />
                            </ActionIcon>
                          </Tooltip>
                        )}
                        {aiEnabled && isPdf(d) && (
                          <Tooltip label={`Extract metrics: read the numbers in this PDF into ${d.period}'s data`}>
                            <ActionIcon
                              variant="subtle"
                              color="navy"
                              aria-label={`Extract metrics from ${d.name}`}
                              loading={extracting === aiKey(d)}
                              onClick={() => extract(d)}
                            >
                              <IconTableImport size={15} />
                            </ActionIcon>
                          </Tooltip>
                        )}
                        <Tooltip label="Rename">
                          <ActionIcon variant="subtle" aria-label={`Rename ${d.name}`} onClick={() => { setRenaming(d); setNewName(d.name); }}>
                            <IconPencil size={15} />
                          </ActionIcon>
                        </Tooltip>
                        <ActionIcon color="red" variant="subtle" aria-label={`Remove ${d.name}`} onClick={() => remove(d)}>
                          <IconTrash size={15} />
                        </ActionIcon>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                  {ai[aiKey(d)]?.suggestion && (() => {
                    const s = ai[aiKey(d)]!.suggestion!;
                    const conf = s.confidence === 'high' ? 'teal' : s.confidence === 'medium' ? 'yellow' : 'red';
                    return (
                      <Table.Tr>
                        <Table.Td colSpan={8} p={0} style={{ borderTop: 'none' }}>
                          <Alert color="teal" variant="light" p="xs" m={4} icon={<IconSparkles size={16} />}>
                            <Group gap="sm" wrap="wrap" align="center">
                              <div style={{ flex: 1, minWidth: 260 }}>
                                <Group gap={6}>
                                  <Text size="sm" fw={600}>{s.suggestedName}</Text>
                                  <Badge size="sm" variant="light" color="navy">{s.suggestedPeriod}</Badge>
                                  <Badge size="sm" variant="light" color="gray">{s.suggestedCategory}</Badge>
                                  <Badge size="sm" variant="dot" color={conf}>{s.confidence} confidence</Badge>
                                </Group>
                                <Text size="xs" c="dimmed" mt={2}>{s.vendor ? `${s.vendor} — ` : ''}{s.rationale}</Text>
                                {s.clientMatch === 'no' && (
                                  <Text size="xs" c="red" fw={600} mt={2}>
                                    ⚠ This document looks like it belongs to a different client — check before matching.
                                  </Text>
                                )}
                              </div>
                              <Group gap="xs" wrap="nowrap">
                                <Button size="compact-sm" color="teal" onClick={() => acceptMatch(d, s)}>Match</Button>
                                <Button size="compact-sm" variant="subtle" color="gray" onClick={() => dismissMatch(d)}>Dismiss</Button>
                              </Group>
                            </Group>
                          </Alert>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })()}
                  </Fragment>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>

      <Modal opened={renaming !== null} onClose={() => setRenaming(null)} title="Rename report" size="md">
        <TextInput value={newName} onChange={(e) => setNewName(e.currentTarget.value)} autoFocus />
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setRenaming(null)}>Cancel</Button>
          <Button
            onClick={async () => {
              if (renaming && newName.trim() && newName.trim() !== renaming.name) {
                await patch(renaming, { name: newName.trim() }, 'Renamed.');
              }
              setRenaming(null);
            }}
          >
            Save
          </Button>
        </Group>
      </Modal>

      <Modal opened={review !== null} onClose={() => setReview(null)} title={`Metrics found in ${review?.doc.name ?? ''}`} size="lg">
        {review && (
          <Stack gap="sm">
            {review.extraction.note && <Text size="sm" c="dimmed">{review.extraction.note}</Text>}
            {review.extraction.periodHint && review.extraction.periodHint !== review.doc.period && (
              <Alert color="yellow" p="xs">
                <Text size="xs">
                  This document's content covers <b>{review.extraction.periodHint}</b> but it's filed under <b>{review.doc.period}</b> —
                  metrics import into the quarter the file is FILED under. Cancel and move the file first (AI match does this) if that's wrong.
                </Text>
              </Alert>
            )}
            <Table.ScrollContainer minWidth={560}>
              <Table verticalSpacing={4}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={36}>
                      <Checkbox
                        size="xs"
                        aria-label="Select all metrics"
                        checked={review.checked.size === review.extraction.metrics.length}
                        indeterminate={review.checked.size > 0 && review.checked.size < review.extraction.metrics.length}
                        onChange={(e) =>
                          setReview({ ...review, checked: e.currentTarget.checked ? new Set(review.extraction.metrics.map((_, i) => i)) : new Set() })
                        }
                      />
                    </Table.Th>
                    <Table.Th>Metric</Table.Th>
                    <Table.Th ta="right">Value</Table.Th>
                    <Table.Th>Category</Table.Th>
                    <Table.Th>Key</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {review.extraction.metrics.map((m, i) => (
                    <Table.Tr key={i} opacity={review.checked.has(i) ? 1 : 0.45}>
                      <Table.Td>
                        <Checkbox
                          size="xs"
                          aria-label={`Include ${m.label}`}
                          checked={review.checked.has(i)}
                          onChange={(e) => {
                            const checked = new Set(review.checked);
                            if (e.currentTarget.checked) checked.add(i);
                            else checked.delete(i);
                            setReview({ ...review, checked });
                          }}
                        />
                      </Table.Td>
                      <Table.Td><Text size="sm">{m.label}</Text></Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" fw={600}>
                          {m.value.toLocaleString()}
                          {m.unit && m.unit !== 'count' ? ` ${m.unit}` : ''}
                        </Text>
                      </Table.Td>
                      <Table.Td><Badge size="sm" variant="light" color="gray">{m.category}</Badge></Table.Td>
                      <Table.Td><Text size="xs" c="dimmed" ff="monospace">{m.key}</Text></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <Text size="xs" c="dimmed">
              Imported metrics appear on the Data tab under source “{review.source}” — include/exclude them there like any synced
              metric. Extracting this document again replaces its previous import.
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setReview(null)}>Cancel</Button>
              <Button color="teal" loading={importing} disabled={review.checked.size === 0} onClick={importReviewed}>
                Import {review.checked.size} into {review.doc.period}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}

// ── Meeting tab: pre-wire the agenda, fill it in live, schedule the call ──────
function MeetingTab({
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

  // "Client mentioned a new location" → one click lands it on the board.
  async function flagOpportunity(it: DiscussionItem) {
    try {
      await api.saveOpportunity(clientId, { title: it.topic || 'QBR opportunity', detail: it.response, sourcePeriod: period });
      notifications.show({ color: 'teal', message: 'Added to the Opportunities board.' });
    } catch (e) {
      notifications.show({ color: 'red', title: 'Could not flag', message: e instanceof Error ? e.message : 'Unknown error' });
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
          Reports always use the Mash IT theme (colors and logo from Settings) — the client's logo shows alongside it on the
          report, PDF and deck for the personal touch.
        </Text>
        <Stack>
          <TextInput label="Client display name override" value={brand.name ?? ''} onChange={(e) => setConfig({ ...config, brand: { ...brand, name: e.currentTarget.value } })} />
          <Group align="flex-end">
            <FileButton accept="image/*" onChange={onLogo}>
              {(props) => <Button variant="default" {...props}>Upload client logo</Button>}
            </FileButton>
            {brand.logoDataUri && <Image src={brand.logoDataUri} h={40} w="auto" fit="contain" alt="logo" />}
            {brand.logoDataUri && (
              <Button variant="subtle" color="red" onClick={() => setConfig({ ...config, brand: { ...brand, logoDataUri: undefined } })}>
                Remove logo
              </Button>
            )}
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

// ── Opportunities board: cross-quarter initiatives per client ─────────────────
const OPP_COLUMNS: Array<[Opportunity['status'], string, string]> = [
  ['idea', 'Ideas', 'gray'],
  ['discussing', 'In discussion', 'grape'],
  ['approved', 'Approved', 'teal'],
  ['pushed', 'Pushed to PSA', 'green'],
  ['closed', 'Closed', 'dark'],
];

function OpportunitiesTab({ clientId, period }: { clientId: string; period: string }) {
  const [items, setItems] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [editing, setEditing] = useState<Opportunity | null>(null);
  const [pushing, setPushing] = useState<Opportunity | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const load = () =>
    api
      .listOpportunities(clientId)
      .then((d) => setItems(d.opportunities))
      .catch(() => {})
      .finally(() => setLoading(false));

  useEffect(() => {
    setLoading(true);
    let live = true;
    api
      .listOpportunities(clientId)
      .then((d) => live && setItems(d.opportunities))
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [clientId]);

  async function add() {
    const t = title.trim();
    if (!t) return;
    try {
      await api.saveOpportunity(clientId, { title: t, detail: detail.trim() || undefined, sourcePeriod: period });
      setTitle('');
      setDetail('');
      await load();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Could not add', message: e instanceof Error ? e.message : 'Unknown error' });
    }
  }

  async function save(o: Opportunity, patch: Partial<Opportunity>, quiet = false) {
    // Optimistic: a dragged card lands in its column immediately; a failure
    // reloads the true state.
    setItems((prev) => prev.map((x) => (x.id === o.id ? { ...x, ...patch } : x)));
    try {
      await api.saveOpportunity(clientId, { ...o, ...patch });
      await load();
      if (!quiet) notifications.show({ color: 'teal', message: 'Saved.' });
    } catch (e) {
      await load();
      notifications.show({ color: 'red', title: 'Update failed', message: e instanceof Error ? e.message : 'Unknown error' });
    }
  }

  async function remove(o: Opportunity) {
    if (!window.confirm(`Delete “${o.title}” from the board?`)) return;
    try {
      await api.deleteOpportunity(clientId, o.id);
      notifications.show({ color: 'gray', message: `Removed “${o.title}”.` });
    } catch (e) {
      notifications.show({ color: 'red', title: 'Delete failed', message: e instanceof Error ? e.message : 'Unknown error' });
    }
    await load();
  }

  if (loading) return <Center h={160}><Loader /></Center>;

  return (
    <Stack gap="lg">
      <Card withBorder radius="md" padding="lg">
        <Title order={5} mb={4}>Opportunity board</Title>
        <Text size="xs" c="dimmed" mb="sm">
          Everything the client mentions that could become work — a new location, a refresh, a project — flagged from the
          Meeting tab's agenda (the bulb icon) or added here. Drag cards between columns; push the real ones to Halo.
        </Text>
        <Group wrap="nowrap" align="flex-start">
          <Stack gap="xs" style={{ flex: 1 }}>
            <TextInput
              placeholder="Title — e.g. New location opening in the fall"
              value={title}
              onChange={(e) => setTitle(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add();
              }}
            />
            <Textarea placeholder="Details (optional)" autosize minRows={1} value={detail} onChange={(e) => setDetail(e.currentTarget.value)} />
          </Stack>
          <Button variant="light" leftSection={<IconPlus size={14} />} onClick={add}>Add to board</Button>
        </Group>
      </Card>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }} spacing="sm">
        {OPP_COLUMNS.map(([status, label, color]) => {
          const cards = items.filter((o) => o.status === status);
          return (
            <Stack
              key={status}
              gap="xs"
              p={4}
              style={{
                minHeight: 120,
                borderRadius: 8,
                outline: dragOver === status ? '2px dashed var(--mantine-color-teal-5)' : undefined,
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(status);
              }}
              onDragLeave={() => setDragOver((s) => (s === status ? null : s))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                const id = e.dataTransfer.getData('text/opportunity-id');
                const card = items.find((o) => o.id === id);
                if (card && card.status !== status) save(card, { status }, true);
              }}
            >
              <Group gap={6}>
                <Badge variant="light" color={color}>{label}</Badge>
                <Text size="xs" c="dimmed">{cards.length}</Text>
              </Group>
              {cards.map((o) => (
                <Card
                  key={o.id}
                  withBorder
                  radius="md"
                  padding="sm"
                  draggable
                  style={{ cursor: 'grab' }}
                  onDragStart={(e) => e.dataTransfer.setData('text/opportunity-id', o.id)}
                >
                  <Group justify="space-between" wrap="nowrap" align="flex-start">
                    <Text size="sm" fw={600}>{o.title}</Text>
                    <ActionIcon variant="subtle" size="sm" aria-label={`Edit ${o.title}`} onClick={() => setEditing(o)}>
                      <IconPencil size={14} />
                    </ActionIcon>
                  </Group>
                  {o.detail && <Text size="xs" c="dimmed" lineClamp={3}>{o.detail}</Text>}
                  <Group gap={4} mt={6}>
                    {o.sourcePeriod && <Badge size="xs" variant="outline" color="gray">{o.sourcePeriod} QBR</Badge>}
                    {o.owner && <Badge size="xs" variant="light" color="navy">{o.owner}</Badge>}
                    {o.externalRef && <Badge size="xs" color="green" variant="light">halo #{o.externalRef}</Badge>}
                  </Group>
                  <Group gap={2} mt={8} justify="flex-end" wrap="nowrap">
                    {!o.externalRef && (
                      <Tooltip label="Push to Halo (opportunity or ticket)">
                        <Button size="compact-xs" variant="light" leftSection={<IconTargetArrow size={13} />} onClick={() => setPushing(o)}>
                          Push
                        </Button>
                      </Tooltip>
                    )}
                    <ActionIcon color="red" variant="subtle" aria-label={`Delete ${o.title}`} onClick={() => remove(o)}>
                      <IconTrash size={15} />
                    </ActionIcon>
                  </Group>
                </Card>
              ))}
            </Stack>
          );
        })}
      </SimpleGrid>

      <OpportunityEditModal
        opportunity={editing}
        onClose={() => setEditing(null)}
        onSave={async (patch) => {
          if (editing) await save(editing, patch);
          setEditing(null);
        }}
      />
      <OpportunityPushModal
        clientId={clientId}
        opportunity={pushing}
        onClose={() => setPushing(null)}
        onPushed={async () => {
          setPushing(null);
          await load();
        }}
      />
    </Stack>
  );
}

function OpportunityEditModal({
  opportunity,
  onClose,
  onSave,
}: {
  opportunity: Opportunity | null;
  onClose: () => void;
  onSave: (patch: Partial<Opportunity>) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [owner, setOwner] = useState('');
  const [status, setStatus] = useState<Opportunity['status']>('idea');

  useEffect(() => {
    setTitle(opportunity?.title ?? '');
    setDetail(opportunity?.detail ?? '');
    setOwner(opportunity?.owner ?? '');
    setStatus(opportunity?.status ?? 'idea');
  }, [opportunity]);

  return (
    <Modal opened={opportunity !== null} onClose={onClose} title="Edit opportunity" size="md">
      <Stack gap="sm">
        <TextInput label="Title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
        <Textarea label="Details" autosize minRows={3} value={detail} onChange={(e) => setDetail(e.currentTarget.value)} />
        <TextInput label="Owner" placeholder="Who's driving this — e.g. Jason" value={owner} onChange={(e) => setOwner(e.currentTarget.value)} />
        <Select
          label="Column"
          description="Same as dragging the card — handy on a touch screen."
          data={OPP_COLUMNS.map(([value, label]) => ({ value, label }))}
          value={status}
          onChange={(v) => v && setStatus(v as Opportunity['status'])}
          allowDeselect={false}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave({ title: title.trim() || opportunity?.title, detail, owner, status })}>Save</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Push modal: choose opportunity vs ticket, with full Halo field control. */
function OpportunityPushModal({
  clientId,
  opportunity,
  onClose,
  onPushed,
}: {
  clientId: string;
  opportunity: Opportunity | null;
  onClose: () => void;
  onPushed: () => Promise<void>;
}) {
  const [target, setTarget] = useState<'halo_opportunity' | 'halo_ticket'>('halo_opportunity');
  const [meta, setMeta] = useState<HaloMeta | null>(null);
  const [ticketTypeId, setTicketTypeId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [team, setTeam] = useState<string | null>(null);
  const [priorityId, setPriorityId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!opportunity) return;
    setTarget('halo_opportunity');
    api.haloMeta().then(setMeta).catch(() => setMeta(null));
  }, [opportunity]);

  async function push() {
    if (!opportunity) return;
    setBusy(true);
    try {
      const r = await api.pushOpportunity(clientId, opportunity.id, {
        target,
        ticketTypeId: ticketTypeId ?? undefined,
        agentId: agentId ?? undefined,
        team: team ?? undefined,
        priorityId: priorityId ?? undefined,
      });
      notifications.show({ color: 'teal', message: `${r.pushed.system} #${r.pushed.id} created.` });
      await onPushed();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Push failed', message: e instanceof Error ? e.message : 'Unknown error', autoClose: 10000 });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened={opportunity !== null} onClose={onClose} title={`Push "${opportunity?.title ?? ''}" to Halo`} size="md">
      <Stack gap="sm">
        <SegmentedControl
          value={target}
          onChange={(v) => setTarget(v as 'halo_opportunity' | 'halo_ticket')}
          data={[
            { value: 'halo_opportunity', label: 'Halo opportunity' },
            { value: 'halo_ticket', label: 'Halo ticket' },
          ]}
        />
        {opportunity?.detail && <Text size="xs" c="dimmed">Details sent along: {opportunity.detail}</Text>}
        {target === 'halo_ticket' && (
          <>
            <Select
              label="Ticket type"
              placeholder={meta ? 'Pick a type' : 'Loading from Halo…'}
              data={(meta?.ticketTypes ?? []).map((t) => ({ value: t.id, label: t.name }))}
              value={ticketTypeId}
              onChange={setTicketTypeId}
              searchable
            />
            <Group grow>
              <Select
                label="Assign to"
                placeholder="Agent"
                data={(meta?.agents ?? []).map((a) => ({ value: a.id, label: a.name }))}
                value={agentId}
                onChange={setAgentId}
                searchable
                clearable
              />
              <Select
                label="Team"
                placeholder="Team"
                data={(meta?.teams ?? []).map((t) => ({ value: t.name, label: t.name }))}
                value={team}
                onChange={setTeam}
                clearable
              />
            </Group>
            <Select
              label="Priority"
              placeholder="Priority"
              data={(meta?.priorities ?? []).map((p) => ({ value: p.id, label: p.name }))}
              value={priorityId}
              onChange={setPriorityId}
              clearable
            />
          </>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button loading={busy} onClick={push}>Create in Halo</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
