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
  IconEye,
  IconPencil,
} from '@tabler/icons-react';
import { api, reportUrls } from '../api.js';
import { lastPeriods } from '../periods.js';
import type { Client, Discussion, MetricRow, QbrResponse, ReportConfig, ReportModel, SnapshotView, SystemInfo } from '../types.js';
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
          <Select
            w={190}
            data={periods}
            value={period || null}
            onChange={(v) => v && setPeriod(v)}
            allowDeselect={false}
            placeholder="Quarter"
            aria-label="Quarter"
          />
          <Button leftSection={<IconRefresh size={16} />} loading={syncing} onClick={onSync} disabled={!period}>Sync</Button>
        </Group>
      </Group>

      {error && <Alert color="red" title="Could not build report">{error}. Try running a Sync, or check the client's tool mappings.</Alert>}

      <Tabs defaultValue="report" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="report">Report</Tabs.Tab>
          <Tabs.Tab value="data">Data</Tabs.Tab>
          <Tabs.Tab value="branding">Branding &amp; Sections</Tabs.Tab>
          <Tabs.Tab value="discussion">Discussion &amp; Responses</Tabs.Tab>
          <Tabs.Tab value="workflow">Schedule &amp; Actions</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="report">
          {loading || !period ? (
            <Center h={240}><Loader /></Center>
          ) : qbr ? (
            <ReportTab
              qbr={qbr}
              urls={urls}
              pdfAvailable={system?.pdfAvailable ?? false}
              refresh={refresh}
              clientId={clientId}
              period={period}
              aiEnabled={system?.ai ?? false}
              onChanged={() => setRefresh((n) => n + 1)}
            />
          ) : (
            <Text c="dimmed">No report.</Text>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="data">
          {period && config && (
            <DataTab clientId={clientId} period={period} config={config} setConfig={setConfig} refresh={refresh} onSaved={() => setRefresh((n) => n + 1)} />
          )}
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
function ReportTab({
  qbr,
  urls,
  pdfAvailable,
  refresh,
  clientId,
  period,
  aiEnabled,
  onChanged,
}: {
  qbr: QbrResponse;
  urls: { html: string; pdf: string; deck: string };
  pdfAvailable: boolean;
  refresh: number;
  clientId: string;
  period: string;
  aiEnabled: boolean;
  onChanged: () => void;
}) {
  const [preview, setPreview] = useState(false);
  const [editing, setEditing] = useState(false);
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
        {pdfAvailable ? (
          <Button component="a" href={urls.pdf} target="_blank" variant="default" leftSection={<IconFileTypePdf size={16} />}>PDF</Button>
        ) : (
          <Tooltip label="Server PDF isn't available on this plan — Open report, then print to PDF from the browser.">
            <Button
              variant="default"
              leftSection={<IconFileTypePdf size={16} />}
              onClick={() =>
                notifications.show({
                  color: 'blue',
                  title: 'PDF via the browser',
                  message: 'Use Open report, then Ctrl+P → Save as PDF. Server-side PDF needs the Premium plan.',
                })
              }
            >
              PDF
            </Button>
          </Tooltip>
        )}
        <Button component="a" href={urls.deck} download variant="default" leftSection={<IconPresentation size={16} />}>Deck</Button>
        <Button variant="subtle" leftSection={<IconEye size={16} />} onClick={() => setPreview((p) => !p)}>
          {preview ? 'Hide preview' : 'Preview'}
        </Button>
      </Group>

      {preview && (
        <Card withBorder radius="md" padding={0}>
          <iframe
            title="QBR report preview"
            src={`${urls.html}?v=${refresh}`}
            style={{ width: '100%', height: 640, border: 'none', display: 'block', borderRadius: 8 }}
          />
        </Card>
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
        {loadError ?? 'No snapshot for this quarter.'} Use <b>Sync</b> to pull from the mapped tools — everything lands here for review
        before it appears in the QBR. You can also add manual metrics below after the first sync.
      </Alert>
    );
  }

  const collected = snapshot.metrics.filter((m) => m.source !== 'manual');
  const sources = [...new Set(collected.map((m) => m.source))];
  const fmt = (m: MetricRow) => `${m.value === null ? '—' : String(m.value)}${m.unit && m.unit !== 'count' ? ` ${m.unit}` : ''}`;

  return (
    <Stack gap="lg" maw={900}>
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
                <ActionIcon color="red" variant="subtle" aria-label="Remove section" onClick={() => setConfig({ ...config, customSections: (config.customSections ?? []).filter((x) => x.id !== s.id) })}><IconTrash size={16} /></ActionIcon>
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
                <ActionIcon color="red" variant="subtle" aria-label="Remove item" onClick={() => setDisc({ ...disc, items: disc.items.filter((x) => x.id !== it.id) })}><IconTrash size={16} /></ActionIcon>
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
