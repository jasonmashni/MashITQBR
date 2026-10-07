import { useEffect, useState } from 'react';
import {
  Title,
  Group,
  Button,
  Select,
  Card,
  Text,
  Stack,
  SimpleGrid,
  Loader,
  Center,
  TextInput,
  Textarea,
  NumberInput,
  ActionIcon,
  Badge,
  Tooltip,
  Modal,
  SegmentedControl,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconTrash, IconPlus, IconTargetArrow, IconPencil } from '@tabler/icons-react';
import { api } from '../../api.js';
import type { HaloMeta, Opportunity } from '../../types.js';
import { toastError } from '../../toast.js';
import { HaloFields, EMPTY_HALO_FIELDS, type HaloFieldValues } from './HaloFields.js';

// ── Opportunities board: cross-quarter initiatives per client ─────────────────
const OPP_COLUMNS: Array<[Opportunity['status'], string, string]> = [
  ['idea', 'Ideas', 'gray'],
  ['discussing', 'In discussion', 'grape'],
  ['approved', 'Approved', 'teal'],
  ['pushed', 'Pushed to PSA', 'green'],
  ['closed', 'Closed', 'dark'],
];

// Compact currency for pipeline sums/badges ($12K, $1.2M), internal only.
const oppMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
/** A card's label for its value: "$12K" one-time, "$1.2K/mo" recurring. */
const oppValueLabel = (o: Opportunity): string | null =>
  typeof o.value === 'number' && o.value > 0 ? oppMoney(o.value) + (o.valueKind === 'recurring' ? '/mo' : '') : null;

export function OpportunitiesTab({ clientId, period }: { clientId: string; period: string }) {
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
      toastError('Could not add', e);
    }
  }

  async function save(o: Opportunity, patch: Omit<Partial<Opportunity>, 'value'> & { value?: number | null }, quiet = false) {
    // Optimistic: a dragged card lands in its column immediately; a failure
    // reloads the true state. Only touch `value` when the patch actually carries
    // it (null clears, a number sets), a status/owner-only patch (e.g. a drag)
    // must NOT wipe an existing estimate. `value` is pulled out of the spread so
    // a stray null can't reach the Opportunity type.
    const { value: patchValue, ...rest } = patch;
    setItems((prev) =>
      prev.map((x) => (x.id === o.id ? { ...x, ...rest, ...('value' in patch ? { value: patchValue ?? undefined } : {}) } : x)),
    );
    try {
      await api.saveOpportunity(clientId, { ...o, ...patch });
      await load();
      if (!quiet) notifications.show({ color: 'good', message: 'Saved.' });
    } catch (e) {
      await load();
      toastError('Update failed', e);
    }
  }

  async function remove(o: Opportunity) {
    if (!window.confirm(`Delete “${o.title}” from the board?`)) return;
    try {
      await api.deleteOpportunity(clientId, o.id);
      notifications.show({ color: 'slate', message: `Removed “${o.title}”.` });
    } catch (e) {
      toastError('Delete failed', e);
    }
    await load();
  }

  if (loading) return <Center h={160}><Loader /></Center>;

  // Annualized value of every open (non-closed) opportunity, the roadmap figure.
  const openPipeline = items.reduce(
    (s, o) =>
      o.status !== 'closed' && typeof o.value === 'number' && o.value > 0
        ? s + (o.valueKind === 'recurring' ? o.value * 12 : o.value)
        : s,
    0,
  );

  return (
    <Stack gap="lg">
      <Card withBorder radius="md" padding="lg">
        <Group justify="space-between" align="flex-start" mb={4}>
          <Title order={5}>Opportunity board</Title>
          {openPipeline > 0 && (
            <Badge size="lg" variant="light" color="good" title="Annualized value of open opportunities (internal only)">
              {oppMoney(openPipeline)}/yr open pipeline
            </Badge>
          )}
        </Group>
        <Text size="xs" c="dimmed" mb="sm">
          Everything the client mentions that could become work, a new location, a refresh, a project, flagged from the
          Meeting tab's agenda (the bulb icon) or added here. Drag cards between columns; push the real ones to Halo. Add a
          value (internal only) to build the roadmap pipeline on the dashboard.
        </Text>
        <Group wrap="nowrap" align="flex-start">
          <Stack gap="xs" style={{ flex: 1 }}>
            <TextInput
              placeholder="Title, e.g. New location opening in the fall"
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
          const colValue = cards.reduce(
            (s, c) => s + (typeof c.value === 'number' && c.value > 0 ? (c.valueKind === 'recurring' ? c.value * 12 : c.value) : 0),
            0,
          );
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
              <Group gap={6} justify="space-between" wrap="nowrap">
                <Group gap={6} wrap="nowrap">
                  <Badge variant="light" color={color}>{label}</Badge>
                  <Text size="xs" c="dimmed">{cards.length}</Text>
                </Group>
                {colValue > 0 && <Text size="xs" c="dimmed" title="Annualized pipeline value">{oppMoney(colValue)}/yr</Text>}
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
                    {oppValueLabel(o) && <Badge size="xs" variant="filled" color="good">{oppValueLabel(o)}</Badge>}
                    {o.sourcePeriod && <Badge size="xs" variant="outline" color="slate">{o.sourcePeriod} QBR</Badge>}
                    {o.owner && <Badge size="xs" variant="light" color="navy">{o.owner}</Badge>}
                    {o.externalRef && <Badge size="xs" color="good" variant="light">halo #{o.externalRef}</Badge>}
                  </Group>
                  <Group gap={2} mt={8} justify="flex-end" wrap="nowrap">
                    {!o.externalRef && (
                      <Tooltip label="Push to Halo (opportunity or ticket)">
                        <Button size="compact-xs" variant="light" leftSection={<IconTargetArrow size={13} />} onClick={() => setPushing(o)}>
                          Push
                        </Button>
                      </Tooltip>
                    )}
                    <ActionIcon color="act" variant="subtle" aria-label={`Delete ${o.title}`} onClick={() => remove(o)}>
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
  onSave: (patch: Omit<Partial<Opportunity>, 'value'> & { value?: number | null }) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [owner, setOwner] = useState('');
  const [status, setStatus] = useState<Opportunity['status']>('idea');
  const [value, setValue] = useState<number | ''>('');
  const [valueKind, setValueKind] = useState<'one_time' | 'recurring'>('one_time');

  useEffect(() => {
    setTitle(opportunity?.title ?? '');
    setDetail(opportunity?.detail ?? '');
    setOwner(opportunity?.owner ?? '');
    setStatus(opportunity?.status ?? 'idea');
    setValue(typeof opportunity?.value === 'number' ? opportunity.value : '');
    setValueKind(opportunity?.valueKind === 'recurring' ? 'recurring' : 'one_time');
  }, [opportunity]);

  return (
    <Modal opened={opportunity !== null} onClose={onClose} title="Edit opportunity" size="md">
      <Stack gap="sm">
        <TextInput label="Title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
        <Textarea label="Details" autosize minRows={3} value={detail} onChange={(e) => setDetail(e.currentTarget.value)} />
        <TextInput label="Owner" placeholder="Who's driving this, e.g. Jason" value={owner} onChange={(e) => setOwner(e.currentTarget.value)} />
        <Group grow align="flex-end">
          <NumberInput
            label="Estimated value"
            description="Internal only, never shown to the client."
            placeholder="e.g. 12000"
            prefix="$"
            thousandSeparator=","
            min={0}
            value={value}
            onChange={(v) => setValue(v === '' || v === undefined ? '' : Number(v))}
          />
          <SegmentedControl
            data={[
              { value: 'one_time', label: 'One-time' },
              { value: 'recurring', label: 'Monthly (MRR)' },
            ]}
            value={valueKind}
            onChange={(v) => setValueKind(v as 'one_time' | 'recurring')}
          />
        </Group>
        <Select
          label="Column"
          description="Same as dragging the card, handy on a touch screen."
          data={OPP_COLUMNS.map(([value, label]) => ({ value, label }))}
          value={status}
          onChange={(v) => v && setStatus(v as Opportunity['status'])}
          allowDeselect={false}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() =>
              onSave({
                title: title.trim() || opportunity?.title,
                detail,
                owner,
                status,
                value: value === '' ? null : value,
                valueKind: value === '' ? undefined : valueKind,
              })
            }
          >
            Save
          </Button>
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
  const [halo, setHalo] = useState<HaloFieldValues>(EMPTY_HALO_FIELDS);
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
        ticketTypeId: halo.ticketTypeId ?? undefined,
        agentId: halo.agentId ?? undefined,
        team: halo.team ?? undefined,
        priorityId: halo.priorityId ?? undefined,
      });
      notifications.show({ color: 'good', message: `${r.pushed.system} #${r.pushed.id} created.` });
      await onPushed();
    } catch (e) {
      notifications.show({ color: 'act', title: 'Push failed', message: e instanceof Error ? e.message : 'Unknown error', autoClose: 10000 });
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
        {target === 'halo_ticket' && <HaloFields meta={meta} value={halo} onChange={setHalo} />}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button loading={busy} onClick={push}>Create in Halo</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
