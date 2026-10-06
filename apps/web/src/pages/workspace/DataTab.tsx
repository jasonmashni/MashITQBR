import { useEffect, useState } from 'react';
import {
  Group,
  Button,
  Select,
  Card,
  Text,
  Stack,
  Alert,
  Loader,
  Center,
  TextInput,
  Checkbox,
  ActionIcon,
  Badge,
  Tooltip,
  Table,
  Modal,
  Anchor,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconTrash, IconPlus, IconDownload, IconExternalLink } from '@tabler/icons-react';
import { api } from '../../api.js';
import type { MetricRow, ReportConfig, SnapshotView } from '../../types.js';
import { toastError } from '../../toast.js';
import { SECTIONS } from './shared.js';

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

// ── Data review tab ───────────────────────────────────────────────────────────
export function DataTab({
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
      toastError('Save failed', e);
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
  // Millions read as 68.5M; fractional values keep one decimal (77.8 GB).
  const fmtNum = (v: number) =>
    Math.abs(v) >= 1e6 ? `${Math.round(v / 1e5) / 10}M` : Number.isInteger(v) ? v.toLocaleString() : String(Math.round(v * 10) / 10);
  const fmt = (m: MetricRow) =>
    `${m.value === null ? '—' : typeof m.value === 'number' ? fmtNum(m.value) : String(m.value)}${m.unit && m.unit !== 'count' ? ` ${m.unit}` : ''}`;

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
            <Badge variant="light" color={source.startsWith('pdf:') ? 'grape' : 'navy'}>{source}</Badge>
            <Text size="xs" c="dimmed">{collected.filter((m) => m.source === source).length} metric(s)</Text>
            {source.startsWith('pdf:') && (
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                ml="auto"
                onClick={async () => {
                  if (!window.confirm(`Remove every metric imported from ${source} out of ${period}? The PDF itself stays in Reports.`)) return;
                  try {
                    const r = await api.removeImportedMetrics(clientId, period, source);
                    notifications.show({ color: 'teal', message: `${r.removed} imported metric(s) removed from ${period}.` });
                    onSaved();
                  } catch (e) {
                    notifications.show({ color: 'red', message: e instanceof Error ? e.message : 'Remove failed' });
                  }
                }}
              >
                Remove import
              </Button>
            )}
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
