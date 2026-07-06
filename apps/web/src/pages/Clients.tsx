import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Title,
  Group,
  Button,
  Card,
  Table,
  Anchor,
  Badge,
  Modal,
  TextInput,
  Switch,
  Stack,
  Text,
  Fieldset,
  Loader,
  Center,
  ActionIcon,
  Tooltip,
  SegmentedControl,
  Autocomplete,
  Select,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconDownload, IconPlus, IconPencil, IconExternalLink, IconRefresh } from '@tabler/icons-react';
import { api } from '../api.js';
import { lastPeriods } from '../periods.js';
import type { Client } from '../types.js';

// Per-client external ids the sync pipeline reads off `integrationRefs`.
const REF_FIELDS: Array<[string, string]> = [
  ['halo', 'Halo client id'],
  ['ninja', 'NinjaOne org id'],
  ['huntress', 'Huntress org id'],
  ['checkpoint', 'Check Point id'],
  ['zomentum', 'Zomentum client id'],
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'client';

export function Clients() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [opened, { open, close }] = useDisclosure(false);
  const [draft, setDraft] = useState<Client | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [filter, setFilter] = useState<'qbr' | 'all'>('qbr');
  const [syncPeriod, setSyncPeriod] = useState('');
  const [syncing, setSyncing] = useState<{ done: number; total: number } | null>(null);

  const load = () => api.listClients().then((d) => setClients(d.clients)).finally(() => setLoading(false));
  useEffect(() => {
    load();
    api.currentPeriod().then((p) => setSyncPeriod(p.period)).catch(() => {});
  }, []);

  /** Sync every QBR-enabled client for the chosen quarter, sequentially (gentle on the vendor APIs). */
  async function syncAll() {
    const targets = clients.filter((c) => c.qbrEnabled !== false);
    if (targets.length === 0 || !syncPeriod) return;
    setSyncing({ done: 0, total: targets.length });
    let ok = 0;
    const failed: string[] = [];
    for (const c of targets) {
      try {
        await api.sync(c.id, syncPeriod);
        ok += 1;
      } catch {
        failed.push(c.name);
      }
      setSyncing((s) => (s ? { ...s, done: s.done + 1 } : s));
    }
    setSyncing(null);
    notifications.show({
      color: failed.length ? 'yellow' : 'teal',
      title: `Synced ${ok}/${targets.length} for ${syncPeriod}`,
      message: failed.length ? `Couldn't sync: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}` : 'All QBR clients pulled fresh data.',
    });
    await load();
  }

  async function onImport() {
    setImporting(true);
    try {
      const { imported } = await api.importHalo();
      notifications.show({ color: 'teal', title: 'Import complete', message: `${imported} client(s) imported from Halo.` });
      await load();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Import failed', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setImporting(false);
    }
  }

  function edit(c: Client) {
    setDraft({ ...c, integrationRefs: { ...(c.integrationRefs ?? {}) } });
    setIsNew(false);
    open();
  }
  function create() {
    setDraft({ id: '', name: '', integrationRefs: {} });
    setIsNew(true);
    open();
  }

  async function save() {
    if (!draft) return;
    const id = isNew ? slug(draft.name) : draft.id;
    if (!draft.name.trim()) {
      notifications.show({ color: 'red', message: 'Client name is required.' });
      return;
    }
    // Drop empty ref values.
    const refs = Object.fromEntries(Object.entries(draft.integrationRefs ?? {}).filter(([, v]) => v && v.trim()));
    try {
      await api.updateClient(id, {
        name: draft.name,
        industry: draft.industry,
        hipaa: draft.hipaa,
        complianceStandard: draft.complianceStandard?.trim() || undefined,
        integrationRefs: refs,
      });
      notifications.show({ color: 'teal', message: `Saved ${draft.name}.` });
      close();
      await load();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Save failed', message: e instanceof Error ? e.message : 'Unknown error' });
    }
  }

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <div>
          <Title order={2}>Clients</Title>
          <Text c="dimmed" size="sm">Flip <b>QBR</b> on for the clients you review — only those appear on the dashboard. Imports start off.</Text>
        </div>
        <Group>
          {syncPeriod && (
            <Select
              aria-label="Quarter to sync"
              size="sm"
              w={120}
              data={lastPeriods(syncPeriod, 6)}
              value={syncPeriod}
              onChange={(v) => v && setSyncPeriod(v)}
              allowDeselect={false}
              disabled={!!syncing}
            />
          )}
          <Button
            variant="light"
            leftSection={<IconRefresh size={16} />}
            loading={!!syncing}
            onClick={syncAll}
            disabled={clients.filter((c) => c.qbrEnabled !== false).length === 0}
          >
            {syncing ? `Syncing ${syncing.done}/${syncing.total}…` : 'Sync all'}
          </Button>
          <Button variant="default" leftSection={<IconPlus size={16} />} onClick={create}>New client</Button>
          <Button leftSection={<IconDownload size={16} />} loading={importing} onClick={onImport}>Import from Halo</Button>
        </Group>
      </Group>

      <Card withBorder radius="md" padding="lg">
        <Group justify="space-between" mb="sm">
          <SegmentedControl
            size="xs"
            value={filter}
            onChange={(v) => setFilter(v as 'qbr' | 'all')}
            data={[
              { value: 'qbr', label: `QBR clients (${clients.filter((c) => c.qbrEnabled !== false).length})` },
              { value: 'all', label: `All (${clients.length})` },
            ]}
          />
          {filter === 'qbr' && clients.some((c) => c.qbrEnabled === false) && (
            <Text size="xs" c="dimmed">Switch to “All” to enable QBRs on imported clients.</Text>
          )}
        </Group>
        {loading ? (
          <Center h={160}><Loader /></Center>
        ) : clients.length === 0 ? (
          <Text c="dimmed" size="sm">No clients yet. Add one, or import from Halo.</Text>
        ) : (
          <Table highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Client</Table.Th>
                <Table.Th>QBR</Table.Th>
                <Table.Th>Industry</Table.Th>
                <Table.Th>Mapped tools</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {clients.filter((c) => filter === 'all' || c.qbrEnabled !== false).map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td>
                    <Group gap={6}>
                      <Anchor component={Link} to={`/clients/${c.id}`} fw={600}>{c.name}</Anchor>
                      {c.hipaa && <Badge size="xs" color="grape" variant="light">HIPAA</Badge>}
                      {c.complianceStandard && c.complianceStandard.toUpperCase() !== 'HIPAA' && (
                        <Badge size="xs" color="navy" variant="light">{c.complianceStandard}</Badge>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Switch
                      size="sm"
                      color="teal"
                      aria-label={`QBRs for ${c.name}`}
                      checked={c.qbrEnabled !== false}
                      onChange={async (e) => {
                        const qbrEnabled = e.currentTarget.checked;
                        setClients((cs) => cs.map((x) => (x.id === c.id ? { ...x, qbrEnabled } : x)));
                        try {
                          await api.updateClient(c.id, { name: c.name, qbrEnabled });
                        } catch {
                          notifications.show({ color: 'red', message: 'Could not update the QBR flag.' });
                          await load();
                        }
                      }}
                    />
                  </Table.Td>
                  <Table.Td>{c.industry ?? '—'}</Table.Td>
                  <Table.Td>
                    <Group gap={4}>
                      {Object.keys(c.integrationRefs ?? {}).length === 0 ? (
                        <Text size="sm" c="dimmed">none</Text>
                      ) : (
                        Object.keys(c.integrationRefs ?? {}).map((k) => (
                          <Badge key={k} size="sm" variant="dot" color="teal">{k}</Badge>
                        ))
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Group gap={4} justify="flex-end">
                      <Tooltip label="Edit mappings">
                        <ActionIcon variant="subtle" color="gray" aria-label={`Edit ${c.name}`} onClick={() => edit(c)}><IconPencil size={16} /></ActionIcon>
                      </Tooltip>
                      <Tooltip label="Open workspace">
                        <ActionIcon variant="subtle" component={Link} to={`/clients/${c.id}`} aria-label={`Open ${c.name} workspace`}><IconExternalLink size={16} /></ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Card>

      <Modal opened={opened} onClose={close} title={isNew ? 'New client' : `Edit ${draft?.name ?? ''}`} size="md">
        {draft && (
          <Stack>
            <TextInput label="Name" required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })} />
            {isNew && <Text size="xs" c="dimmed">Client id will be <b>{slug(draft.name || 'client')}</b>.</Text>}
            <TextInput label="Industry" value={draft.industry ?? ''} onChange={(e) => setDraft({ ...draft, industry: e.currentTarget.value })} />
            <Autocomplete
              label="Compliance standard"
              description="The framework this client answers to — the QBR narrative and scorecard framing reflect it with a light touch."
              placeholder="e.g. HIPAA, TISAX, SOC 2, CMMC, PCI DSS"
              data={['HIPAA', 'TISAX', 'SOC 2', 'CMMC', 'PCI DSS', 'NIST 800-171', 'ISO 27001', 'FTC Safeguards']}
              value={draft.complianceStandard ?? ''}
              onChange={(v) => setDraft({ ...draft, complianceStandard: v })}
            />
            <Switch label="HIPAA client (ePHI handling)" checked={!!draft.hipaa} onChange={(e) => setDraft({ ...draft, hipaa: e.currentTarget.checked })} />
            <Fieldset legend="Tool mappings (per-client external ids)">
              <Stack gap="xs">
                {REF_FIELDS.map(([key, label]) => (
                  <TextInput
                    key={key}
                    label={label}
                    placeholder="—"
                    value={draft.integrationRefs?.[key] ?? ''}
                    onChange={(e) => setDraft({ ...draft, integrationRefs: { ...draft.integrationRefs, [key]: e.currentTarget.value } })}
                  />
                ))}
              </Stack>
            </Fieldset>
            <Group justify="flex-end">
              <Button variant="default" onClick={close}>Cancel</Button>
              <Button onClick={save}>Save</Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
