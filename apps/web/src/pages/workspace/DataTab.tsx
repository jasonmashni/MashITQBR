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
  List,
} from '@mantine/core';
import { IconTrash, IconPlus, IconDownload, IconExternalLink, IconAlertTriangle } from '@tabler/icons-react';
import { api } from '../../api.js';
import { metricValue } from '../../format.js';
import type { MetricRow, ReportConfig, SnapshotView } from '../../types.js';
import { toastError, toastOk } from '../../toast.js';
import { ConfirmModal } from '../../ui.js';
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

/**
 * Everything Sync pulled, reviewed before it enters the QBR. Caveats from the
 * sync sit at the top so a sampled count is never mistaken for a complete one;
 * a failed load disables Save so nothing empty can be written back.
 */
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
  const [warnings, setWarnings] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState<MetricRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [draft, setDraft] = useState({ label: '', value: '', unit: '', category: 'security' });
  // The metric whose backing rows (tickets, invoice lines, devices) are open.
  const [detail, setDetail] = useState<MetricRow | null>(null);
  const [removeSource, setRemoveSource] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .getMetrics(clientId, period)
      .then((d) => {
        if (!live) return;
        setSnapshot(d.snapshot);
        setWarnings(d.warnings ?? d.snapshot.warnings ?? []);
        setExcluded(new Set(d.excluded));
        setManual(d.snapshot.metrics.filter((m) => m.source === 'manual'));
        setLoadError(null);
        setDirty(false);
        onDirty?.(false);
      })
      .catch((e) => live && setLoadError(e instanceof Error ? e.message : 'No data'))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [clientId, period, refresh]);

  const markDirty = () => {
    setDirty(true);
    onDirty?.(true);
  };

  function addManual() {
    if (!draft.label.trim() || draft.value === '') {
      toastError('Manual metrics need a label and a value', new Error('Fill in both fields, then add it.'));
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
    markDirty();
  }

  async function save() {
    setSaving(true);
    try {
      await api.putManualMetrics(clientId, period, manual);
      const nextConfig = { ...config, clientId, excludedMetrics: [...excluded] };
      await api.putConfig(clientId, nextConfig);
      setConfig(nextConfig);
      toastOk('Data review saved. The report reflects it immediately.');
      setDirty(false);
      onDirty?.(false);
      onSaved();
    } catch (e) {
      toastError('Save failed', e);
    } finally {
      setSaving(false);
    }
  }

  async function removeImport() {
    if (!removeSource) return;
    setRemoving(true);
    try {
      const r = await api.removeImportedMetrics(clientId, period, removeSource);
      toastOk(`${r.removed} imported metric${r.removed === 1 ? '' : 's'} removed from ${period}.`);
      setRemoveSource(null);
      onSaved();
    } catch (e) {
      toastError('Remove failed', e);
    } finally {
      setRemoving(false);
    }
  }

  if (loading) return <Center h={200}><Loader /></Center>;
  if (loadError || !snapshot) {
    return (
      <Alert color="slate" variant="light" title={`No data for ${period} yet`}>
        {loadError && loadError !== 'No data' ? `${loadError}. ` : ''}
        Use Sync in the header to pull from the connected tools. Everything lands here for review before it appears in the QBR; manual metrics can be added after the first sync.
      </Alert>
    );
  }

  const collected = snapshot.metrics.filter((m) => m.source !== 'manual');
  const sources = [...new Set(collected.map((m) => m.source))];
  const pulled = new Date(snapshot.capturedAt).toLocaleString();

  return (
    <Stack gap="lg">
      {warnings.length > 0 && (
        <Alert color="watch" variant="light" icon={<IconAlertTriangle size={18} />} title="Data confidence">
          <Text size="xs" c="dimmed" mb={4}>These notes travel with the data and print on the report.</Text>
          <List size="sm" spacing={2}>{warnings.map((w, i) => <List.Item key={i}>{w}</List.Item>)}</List>
        </Alert>
      )}
      <Group justify="space-between" align="flex-start">
        <Text size="sm" c="dimmed" maw="60ch">
          Pulled {pulled}: {collected.length} metric{collected.length === 1 ? '' : 's'} from {sources.length} source{sources.length === 1 ? '' : 's'}.
          Untick anything you do not want in the QBR; the report, the scorecard and the narrative all respect it.
        </Text>
        <Button loading={saving} onClick={save} disabled={!dirty}>
          Save review
        </Button>
      </Group>

      {sources.map((source) => (
        <Card key={source} padding="lg">
          <Group mb="sm" gap="xs">
            <Badge color={source.startsWith('pdf:') ? 'navy' : 'brand'}>{source}</Badge>
            <Text size="xs" c="dimmed">{collected.filter((m) => m.source === source).length} metrics</Text>
            {source.startsWith('pdf:') && (
              <Button size="compact-xs" variant="subtle" color="act" ml="auto" onClick={() => setRemoveSource(source)}>
                Remove import
              </Button>
            )}
          </Group>
          <Table verticalSpacing={6}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={70}>Include</Table.Th>
                <Table.Th>Metric</Table.Th>
                <Table.Th ta="right">Value</Table.Th>
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
                          markDirty();
                        }}
                      />
                    </Table.Td>
                    <Table.Td><Text size="sm">{m.label}</Text></Table.Td>
                    <Table.Td ta="right" data-num>
                      {m.details?.length ? (
                        <Tooltip label={`View the ${m.details.length} row${m.details.length === 1 ? '' : 's'} behind this number`}>
                          <Anchor component="button" type="button" size="sm" fw={600} onClick={() => setDetail(m)}>
                            {metricValue(m)}
                          </Anchor>
                        </Tooltip>
                      ) : (
                        <Text size="sm" fw={600}>{metricValue(m)}</Text>
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
        title={detail ? `${detail.label}: ${detail.details?.length ?? 0} row${(detail.details?.length ?? 0) === 1 ? '' : 's'}` : ''}
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
                              <ActionIcon component="a" href={row['url']} target="_blank" variant="subtle" size="sm" aria-label="Open in the source tool">
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
            Showing the first {detail.details?.length} of {detail.value}. The full set lives in the source tool.
          </Text>
        )}
      </Modal>

      <ConfirmModal
        opened={removeSource !== null}
        title={`Remove the ${removeSource ?? ''} import?`}
        confirmLabel="Remove import"
        color="act"
        loading={removing}
        onCancel={() => setRemoveSource(null)}
        onConfirm={removeImport}
      >
        <Text size="sm">Every metric imported from {removeSource} leaves {period}. The PDF itself stays on the Reports tab.</Text>
      </ConfirmModal>

      <Card padding="lg">
        <Group mb="sm" gap="xs">
          <Badge color="good">manual</Badge>
          <Text size="xs" c="dimmed">Numbers the APIs cannot provide: Synology backups, SAT completion, canaries.</Text>
        </Group>
        <Stack gap="xs">
          {manual.map((m, i) => (
            <Group key={m.key + i} wrap="nowrap">
              <Text size="sm" style={{ flex: 1 }}>{m.label}</Text>
              <Text size="sm" fw={600} data-num>{metricValue(m)}</Text>
              <Text size="sm" c="dimmed">{m.category}</Text>
              <ActionIcon
                color="act"
                variant="subtle"
                aria-label={`Remove ${m.label}`}
                onClick={() => {
                  setManual(manual.filter((_, j) => j !== i));
                  markDirty();
                }}
              >
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
