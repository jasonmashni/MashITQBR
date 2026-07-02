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
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconDownload, IconPlus, IconPencil, IconExternalLink } from '@tabler/icons-react';
import { api } from '../api.js';
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

  const load = () => api.listClients().then((d) => setClients(d.clients)).finally(() => setLoading(false));
  useEffect(() => {
    load();
  }, []);

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
      await api.updateClient(id, { name: draft.name, industry: draft.industry, hipaa: draft.hipaa, integrationRefs: refs });
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
        <Title order={2}>Clients</Title>
        <Group>
          <Button variant="default" leftSection={<IconPlus size={16} />} onClick={create}>New client</Button>
          <Button leftSection={<IconDownload size={16} />} loading={importing} onClick={onImport}>Import from Halo</Button>
        </Group>
      </Group>

      <Card withBorder radius="md" padding="lg">
        {loading ? (
          <Center h={160}><Loader /></Center>
        ) : clients.length === 0 ? (
          <Text c="dimmed" size="sm">No clients yet. Add one, or connect the MASH MCP and import from Halo.</Text>
        ) : (
          <Table highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Client</Table.Th>
                <Table.Th>Industry</Table.Th>
                <Table.Th>Mapped tools</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {clients.map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td>
                    <Group gap={6}>
                      <Anchor component={Link} to={`/clients/${c.id}`} fw={600}>{c.name}</Anchor>
                      {c.hipaa && <Badge size="xs" color="grape" variant="light">HIPAA</Badge>}
                    </Group>
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
