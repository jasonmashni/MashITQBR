import { Fragment, useEffect, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Title,
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
  FileButton,
  Tooltip,
  Table,
  Modal,
  Anchor,
  CopyButton,
  Popover,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconTrash,
  IconPencil,
  IconUpload,
  IconSparkles,
  IconTableImport,
  IconInfoCircle,
  IconMail,
} from '@tabler/icons-react';
import { api, documentUrl } from '../../api.js';
import type { DocExtraction, DocMatchSuggestion, DocumentInfo } from '../../types.js';
import { toastError } from '../../toast.js';
import { SECTIONS } from './shared.js';

const DOC_CATEGORIES = ['Security', 'Backup', 'Endpoint', 'Email', 'Network', 'Compliance', 'Billing', 'Other'];
/** Metric categories = report sections; labels come from SECTIONS in shared.ts. */
const METRIC_CATEGORY_OPTIONS = SECTIONS.map(([value, label]) => ({ value, label }));

// ── Attached documents (vendor reports + uploads) ─────────────────────────────
export function ReportsTab({
  clientId,
  period,
  periods,
  refresh,
  reportsMailbox,
  aiEnabled,
  lockedPeriods = {},
  onChanged,
}: {
  clientId: string;
  period: string;
  periods: Array<{ value: string; label: string }>;
  refresh: number;
  reportsMailbox: string | null;
  aiEnabled: boolean;
  /** Lock sentence per locked quarter: its documents cannot change until a Reopen. */
  lockedPeriods?: Record<string, string>;
  onChanged: () => void;
}) {
  const uploadLock = lockedPeriods[period];
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
  const [review, setReview] = useState<{ doc: DocumentInfo; extraction: DocExtraction; source: string; checked: Set<number>; target: string } | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    let live = true;
    api.listClientDocuments(clientId).then((d) => live && setDocs(d.documents)).catch(() => live && setDocs([]));
    return () => {
      live = false;
    };
  }, [clientId, refresh]);

  const reload = () => api.listClientDocuments(clientId).then((d) => setDocs(d.documents)).catch(() => {});

  // Quiet background refresh: emailed/synced reports appear without a manual
  // browser reload. Fingerprint the list so unchanged polls don't re-render
  // (open modals and row selections stay untouched).
  const docsRef = useRef<DocumentInfo[] | null>(null);
  docsRef.current = docs;
  useEffect(() => {
    const fingerprint = (list: DocumentInfo[]) => list.map((d) => `${d.period}:${d.id}:${d.uploadedAt}:${d.name}`).sort().join('|');
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const { documents } = await api.listClientDocuments(clientId);
        const prev = docsRef.current;
        if (prev === null || fingerprint(documents) === fingerprint(prev)) return;
        const known = new Set(prev.map((d) => `${d.period}:${d.id}`));
        const fresh = documents.filter((d) => !known.has(`${d.period}:${d.id}`));
        if (fresh.length > 0) {
          notifications.show({
            color: 'good',
            title: `New report${fresh.length > 1 ? 's' : ''} arrived`,
            message: fresh.map((f) => f.name).join(', '),
          });
        }
        setDocs(documents);
      } catch {
        // Background refresh never nags, the next tick retries.
      }
    };
    const t = window.setInterval(tick, 45_000);
    return () => window.clearInterval(t);
  }, [clientId]);

  const [pollingInbox, setPollingInbox] = useState(false);
  async function checkInboxNow() {
    setPollingInbox(true);
    try {
      const r = await api.pollInbox();
      notifications.show({
        color: r.filed > 0 ? 'teal' : 'gray',
        message: r.filed > 0 ? `${r.filed} report(s) filed from the inbox.` : `Inbox checked, nothing new (${r.processed} unread message(s) seen).`,
      });
      if (r.filed > 0) {
        await reload();
        onChanged();
      }
    } catch (e) {
      toastError('Inbox check failed', e);
    } finally {
      setPollingInbox(false);
    }
  }

  async function upload(file: File | null) {
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      notifications.show({ color: 'act', message: 'Files up to 15 MB.' });
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
      notifications.show({ color: 'good', message: `${file.name} filed under ${period}.` });
      await reload();
      onChanged();
    } catch (e) {
      toastError('Upload failed', e);
    } finally {
      setUploading(false);
    }
  }

  async function patch(doc: DocumentInfo, body: { name?: string; category?: string; period?: string }, note: string) {
    try {
      await api.updateDocument(clientId, doc.period, doc.id, body);
      notifications.show({ color: 'good', message: note });
      await reload();
      onChanged();
    } catch (e) {
      toastError('Update failed', e);
    }
  }

  async function remove(doc: DocumentInfo) {
    if (!window.confirm(`Permanently delete “${doc.name}”? It also disappears from the ${doc.period} report appendix.`)) return;
    try {
      await api.deleteDocument(clientId, doc.period, doc.id);
      notifications.show({ color: 'slate', message: `Removed ${doc.name}.` });
      await reload();
      onChanged();
    } catch (e) {
      toastError('Delete failed', e);
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
      toastError(`AI match failed for ${d.name}`, e);
    }
  }

  /** Analyze every PDF that doesn't have a suggestion yet (sequential, each is a model call). */
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
        notifications.show({ color: 'watch', message: `No importable metrics found in ${d.name}.` });
      } else {
        // Default the target quarter to what the CONTENT covers (a previous
        // QBR filed under this quarter should trend, not pollute it).
        const hint = /^20\d{2}-Q[1-4]$/.test(extraction.periodHint) ? extraction.periodHint : null;
        setReview({ doc: d, extraction, source, checked: new Set(extraction.metrics.map((_, i) => i)), target: hint ?? d.period });
      }
    } catch (e) {
      toastError(`Extraction failed for ${d.name}`, e);
    } finally {
      setExtracting(null);
    }
  }

  async function importReviewed() {
    if (!review) return;
    setImporting(true);
    try {
      const metrics = review.extraction.metrics.filter((_, i) => review.checked.has(i));
      const r = await api.importDocMetrics(clientId, review.target, { source: review.source, metrics });
      notifications.show({ color: 'good', message: `${r.imported} metric(s) added to ${review.target}, review them on the Data tab.` });
      setReview(null);
      onChanged();
    } catch (e) {
      toastError('Import failed', e);
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
        <Group justify="space-between" wrap="nowrap">
          <Group gap={6}>
            <Title order={5}>Reports</Title>
            <Popover width={340} withArrow position="bottom-start" shadow="md">
              <Popover.Target>
                <ActionIcon variant="subtle" color="slate" size="sm" aria-label="How reports work">
                  <IconInfoCircle size={17} />
                </ActionIcon>
              </Popover.Target>
              <Popover.Dropdown>
                <Text size="xs">
                  Every vendor report and upload for this client, across all quarters (Huntress attaches on Sync, forwarded
                  email files itself, uploads land in the selected quarter). Rename, categorize, or move any to the right
                  quarter, or <b>AI match</b> fills all three. The <b>table-import</b> icon (
                  <IconTableImport size={12} style={{ verticalAlign: 'middle' }} />) reads a PDF's numbers into that quarter's data.
                </Text>
                <Text size="xs" mt="xs">
                  <b>Add a previous QBR:</b> upload it, click <IconTableImport size={12} style={{ verticalAlign: 'middle' }} />,
                  confirm the auto-detected <b>target quarter</b> in the review, and accept, those figures become that quarter's
                  snapshot, so this report shows real quarter-over-quarter trends.
                </Text>
              </Popover.Dropdown>
            </Popover>
          </Group>
          <Group gap="xs">
            {aiEnabled && (docs ?? []).some(isPdf) && (
              <Button variant="subtle" color="brand" loading={bulkMatching} leftSection={<IconSparkles size={16} />} onClick={analyzeAll}>
                AI match
              </Button>
            )}
            <Tooltip label={uploadLock} disabled={!uploadLock} multiline w={300}>
              <div>
                <FileButton onChange={upload} accept="application/pdf,image/*,.csv,.xlsx,.docx" disabled={Boolean(uploadLock)}>
                  {(props) => (
                    <Button {...props} loading={uploading} leftSection={<IconUpload size={16} />} disabled={Boolean(uploadLock)}>
                      Upload to {period}
                    </Button>
                  )}
                </FileButton>
              </div>
            </Tooltip>
          </Group>
        </Group>
        {inboxAddress ? (
          <Group gap="xs" wrap="nowrap" mt="sm">
            <IconMail size={15} style={{ color: 'var(--mantine-color-dimmed)', flexShrink: 0 }} />
            <Text size="xs" c="dimmed" style={{ flex: 1 }} lineClamp={1}>
              Inbox <Text span fw={600} c="brand.8" style={{ userSelect: 'all' }}>{inboxAddress}</Text>, forward or schedule vendor reports here (tag the subject “2026-Q2” to aim a quarter).
            </Text>
            <CopyButton value={inboxAddress}>
              {({ copied, copy }) => (
                <Button size="compact-xs" variant={copied ? 'filled' : 'subtle'} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
              )}
            </CopyButton>
            <Button size="compact-xs" variant="subtle" loading={pollingInbox} onClick={checkInboxNow}>Check now</Button>
          </Group>
        ) : (
          <Text size="xs" c="dimmed" mt="sm">
            Report inbox not set up, give this client its own forwarding address via the{' '}
            <Anchor component={RouterLink} to="/settings" size="xs">Settings page</Anchor>.
          </Text>
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
                      checked={selected.size > 0 && selected.size === docs.filter((d) => !lockedPeriods[d.period]).length}
                      indeterminate={selected.size > 0 && selected.size < docs.filter((d) => !lockedPeriods[d.period]).length}
                      onChange={(e) => setSelected(e.currentTarget.checked ? new Set(docs.filter((d) => !lockedPeriods[d.period]).map(aiKey)) : new Set())}
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
                      <Button size="compact-xs" color="act" variant="light" loading={bulkDeleting} onClick={removeSelected}>
                        Delete {selected.size}
                      </Button>
                    )}
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {docs.map((d) => {
                  // A locked quarter's documents are frozen with its package.
                  const rowLock = lockedPeriods[d.period];
                  return (
                  <Fragment key={`${d.period}-${d.id}`}>
                  <Table.Tr>
                    <Table.Td>
                      <Checkbox
                        size="xs"
                        aria-label={`Select ${d.name}`}
                        checked={selected.has(aiKey(d))}
                        disabled={Boolean(rowLock)}
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
                        disabled={Boolean(rowLock)}
                        title={rowLock}
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
                        disabled={Boolean(rowLock)}
                        title={rowLock}
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
                          <Tooltip label={rowLock ?? 'AI match: read the PDF and suggest name / quarter / category'} multiline w={rowLock ? 300 : undefined}>
                            <span style={{ display: 'inline-block' }}>
                              <ActionIcon
                                variant="subtle"
                                color="good"
                                aria-label={`AI match ${d.name}`}
                                loading={ai[aiKey(d)]?.loading}
                                disabled={Boolean(rowLock)}
                                onClick={() => analyze(d)}
                              >
                                <IconSparkles size={15} />
                              </ActionIcon>
                            </span>
                          </Tooltip>
                        )}
                        {aiEnabled && isPdf(d) && (
                          <Tooltip label={rowLock ?? `Extract metrics: read the numbers in this PDF into ${d.period}'s data`} multiline w={rowLock ? 300 : undefined}>
                            <span style={{ display: 'inline-block' }}>
                              <ActionIcon
                                variant="subtle"
                                color="navy"
                                aria-label={`Extract metrics from ${d.name}`}
                                loading={extracting === aiKey(d)}
                                disabled={Boolean(rowLock)}
                                onClick={() => extract(d)}
                              >
                                <IconTableImport size={15} />
                              </ActionIcon>
                            </span>
                          </Tooltip>
                        )}
                        <Tooltip label={rowLock ?? 'Rename'} multiline w={rowLock ? 300 : undefined}>
                          <span style={{ display: 'inline-block' }}>
                            <ActionIcon variant="subtle" aria-label={`Rename ${d.name}`} disabled={Boolean(rowLock)} onClick={() => { setRenaming(d); setNewName(d.name); }}>
                              <IconPencil size={15} />
                            </ActionIcon>
                          </span>
                        </Tooltip>
                        <Tooltip label={rowLock ?? 'Delete'} multiline w={rowLock ? 300 : undefined}>
                          <span style={{ display: 'inline-block' }}>
                            <ActionIcon color="act" variant="subtle" aria-label={`Remove ${d.name}`} disabled={Boolean(rowLock)} onClick={() => remove(d)}>
                              <IconTrash size={15} />
                            </ActionIcon>
                          </span>
                        </Tooltip>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                  {ai[aiKey(d)]?.suggestion && (() => {
                    const s = ai[aiKey(d)]!.suggestion!;
                    const conf = s.confidence === 'high' ? 'teal' : s.confidence === 'medium' ? 'yellow' : 'red';
                    return (
                      <Table.Tr>
                        <Table.Td colSpan={8} p={0} style={{ borderTop: 'none' }}>
                          <Alert color="good" variant="light" p="xs" m={4} icon={<IconSparkles size={16} />}>
                            <Group gap="sm" wrap="wrap" align="center">
                              <div style={{ flex: 1, minWidth: 260 }}>
                                <Group gap={6}>
                                  <Text size="sm" fw={600}>{s.suggestedName}</Text>
                                  <Badge size="sm" variant="light" color="navy">{s.suggestedPeriod}</Badge>
                                  <Badge size="sm" variant="light" color="slate">{s.suggestedCategory}</Badge>
                                  <Badge size="sm" variant="dot" color={conf}>{s.confidence} confidence</Badge>
                                </Group>
                                <Text size="xs" c="dimmed" mt={2}>{s.vendor ? `${s.vendor}, ` : ''}{s.rationale}</Text>
                                {s.clientMatch === 'no' && (
                                  <Text size="xs" c="red" fw={600} mt={2}>
                                    ⚠ This document looks like it belongs to a different client, check before matching.
                                  </Text>
                                )}
                              </div>
                              <Group gap="xs" wrap="nowrap">
                                <Tooltip label={rowLock} disabled={!rowLock} multiline w={300}>
                                  <span style={{ display: 'inline-block' }}>
                                    <Button size="compact-sm" color="good" disabled={Boolean(rowLock)} onClick={() => acceptMatch(d, s)}>Match</Button>
                                  </span>
                                </Tooltip>
                                <Button size="compact-sm" variant="subtle" color="slate" onClick={() => dismissMatch(d)}>Dismiss</Button>
                              </Group>
                            </Group>
                          </Alert>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })()}
                  </Fragment>
                  );
                })}
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
            <Group gap="sm" align="flex-end">
              <Select
                label="Import into quarter"
                description="Where these numbers belong, a previous QBR should land in ITS quarter so trends compare against it."
                data={[...new Set([review.target, review.doc.period, ...periods.map((p) => p.value)])].sort().reverse()}
                value={review.target}
                onChange={(v) => v && setReview({ ...review, target: v })}
                w={230}
                allowDeselect={false}
              />
              {review.extraction.periodHint && review.extraction.periodHint === review.target && review.target !== review.doc.period && (
                <Badge color="good" variant="light" mb={6}>AI: content covers {review.extraction.periodHint}</Badge>
              )}
            </Group>
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
                      <Table.Td>
                        <Select
                          size="xs"
                          w={140}
                          aria-label={`Report section for ${m.label}`}
                          data={METRIC_CATEGORY_OPTIONS}
                          value={m.category}
                          allowDeselect={false}
                          onChange={(v) => {
                            if (!v) return;
                            const metrics = review.extraction.metrics.map((row, j) => (j === i ? { ...row, category: v as typeof row.category } : row));
                            setReview({ ...review, extraction: { ...review.extraction, metrics } });
                          }}
                        />
                      </Table.Td>
                      <Table.Td><Text size="xs" c="dimmed" ff="monospace">{m.key}</Text></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <Text size="xs" c="dimmed">
              Imported metrics appear on the Data tab under source “{review.source}”, include/exclude them there like any synced
              metric. The Category picks which report section each lands in. Re-importing the same document replaces its previous import.
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setReview(null)}>Cancel</Button>
              <Button color="good" loading={importing} disabled={review.checked.size === 0} onClick={importReviewed}>
                Import {review.checked.size} into {review.target}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
