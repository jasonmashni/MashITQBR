import { useEffect, useState } from 'react';
import {
  Title,
  Group,
  Button,
  Card,
  SimpleGrid,
  Badge,
  Text,
  Modal,
  Select,
  TextInput,
  PasswordInput,
  Stack,
  Menu,
  ActionIcon,
  Loader,
  Center,
  ThemeIcon,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconDots, IconPlugConnected, IconTrash, IconPlugConnectedX, IconPencil } from '@tabler/icons-react';
import { api, type ConnectionInput } from '../api.js';
import type { ConnectionView, SystemInfo } from '../types.js';

interface Field {
  key: string;
  label: string;
  placeholder?: string;
}
interface TypeDef {
  value: string;
  label: string;
  hint: string;
  config: Field[];
  secrets: Field[];
}

// Field keys align exactly with what the server pipeline reads (see
// integrationsService.ts / actions.ts / handlers.resolveMcp).
const TYPES: TypeDef[] = [
  {
    value: 'mcp',
    label: 'MASH MCP',
    hint: 'HaloPSA, NinjaOne & Hudu read tools. Create an MCP Client on your MCP Setup page and paste its Client ID + Secret.',
    config: [
      { key: 'url', label: 'MCP HTTPS URL', placeholder: 'https://mcpserver.mashit.net/mcp' },
      { key: 'clientId', label: 'Client ID', placeholder: 'mcp-…' },
      { key: 'tokenUrl', label: 'Token URL (optional — auto-discovered when blank)', placeholder: 'https://mcpserver.mashit.net/token' },
      { key: 'tokenAuthMethod', label: "Token auth method (optional: 'basic' or 'post')", placeholder: 'basic' },
    ],
    secrets: [
      { key: 'clientSecret', label: 'Client Secret' },
      { key: 'token', label: 'Static bearer token (legacy — leave blank when using Client ID/Secret)' },
    ],
  },
  {
    value: 'huntress',
    label: 'Huntress',
    hint: 'EDR / ITDR / SAT posture',
    config: [{ key: 'baseUrl', label: 'Base URL (includes /v1)', placeholder: 'https://api.huntress.io/v1' }],
    secrets: [
      { key: 'apiKey', label: 'API Key' },
      { key: 'apiSecret', label: 'API Secret' },
    ],
  },
  {
    value: 'checkpoint',
    label: 'Check Point HEC',
    hint: 'Email security & DLP',
    config: [{ key: 'baseUrl', label: 'Region base URL', placeholder: 'https://smart-api-...cloudinfra.net' }],
    secrets: [{ key: 'token', label: 'API token' }],
  },
  {
    value: 'zomentum',
    label: 'Zomentum',
    hint: 'Push opportunities',
    config: [{ key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.zomentum.com' }],
    secrets: [{ key: 'token', label: 'API bearer token' }],
  },
];

const typeDef = (t: string) => TYPES.find((d) => d.value === t);
const STATUS_COLOR: Record<string, string> = { ok: 'teal', error: 'red', unknown: 'gray' };

export function Integrations() {
  const [conns, setConns] = useState<ConnectionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [opened, { open, close }] = useDisclosure(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ConnectionView | null>(null);
  const secretHome = system?.secretStore === 'keyvault' ? 'Azure Key Vault' : 'the local secret file (dev)';

  const [editId, setEditId] = useState<string | undefined>();
  const [type, setType] = useState('mcp');
  const [label, setLabel] = useState('');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  const load = () => api.listIntegrations().then((d) => setConns(d.integrations)).finally(() => setLoading(false));
  useEffect(() => {
    load();
    api.system().then(setSystem).catch(() => {});
  }, []);

  function openNew() {
    setEditId(undefined);
    setType('mcp');
    setLabel('');
    setConfig({});
    setSecrets({});
    open();
  }
  function openEdit(c: ConnectionView) {
    setEditId(c.id);
    setType(c.type);
    setLabel(c.label);
    setConfig({ ...c.config });
    setSecrets({});
    open();
  }

  async function save() {
    if (!label.trim()) {
      notifications.show({ color: 'red', message: 'A label is required.' });
      return;
    }
    const input: ConnectionInput = { type, label, config, secrets };
    const savedSecrets = Object.values(secrets).some((v) => v && v.length > 0);
    try {
      if (editId) await api.updateIntegration(editId, input);
      else await api.createIntegration(input);
      notifications.show({ color: 'teal', message: `Saved ${label}.${savedSecrets ? ` Secrets stored in ${secretHome}.` : ''}` });
      close();
      await load();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Save failed', message: e instanceof Error ? e.message : 'Unknown error' });
    }
  }

  async function test(c: ConnectionView) {
    setTesting(c.id);
    try {
      const r = await api.testIntegration(c.id);
      notifications.show({
        color: r.ok ? 'teal' : 'red',
        title: r.ok ? 'Connection OK' : 'Connection failed',
        message: r.error ?? r.note ?? (r.ok ? 'Reachable.' : 'Unknown error'),
      });
      await load(); // the test result is persisted on the connection — refresh the card
    } catch (e) {
      notifications.show({ color: 'red', title: 'Test failed', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setTesting(null);
    }
  }

  async function remove(c: ConnectionView) {
    try {
      await api.deleteIntegration(c.id);
      notifications.show({ color: 'gray', message: `Deleted ${c.label} and purged its secrets.` });
      await load();
    } catch (e) {
      notifications.show({ color: 'red', title: 'Delete failed', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setConfirmDelete(null);
    }
  }

  const def = typeDef(type);

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <div>
          <Title order={2}>Integrations</Title>
          <Text c="dimmed" size="sm">Credentials are written to {secretHome}; only references are stored here.</Text>
        </div>
        <Button leftSection={<IconPlus size={16} />} onClick={openNew}>Add integration</Button>
      </Group>

      {loading ? (
        <Center h={160}><Loader /></Center>
      ) : conns.length === 0 ? (
        <Card withBorder radius="md" padding="xl">
          <Center>
            <Stack align="center" gap="xs">
              <ThemeIcon size={48} radius="md" variant="light" color="navy"><IconPlugConnected size={26} /></ThemeIcon>
              <Text fw={600}>No integrations yet</Text>
              <Text c="dimmed" size="sm">Add the MASH MCP to pull Halo/Ninja/Hudu, plus Huntress, Check Point and Zomentum.</Text>
              <Button mt="sm" variant="light" leftSection={<IconPlus size={16} />} onClick={openNew}>Add your first integration</Button>
            </Stack>
          </Center>
        </Card>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
          {conns.map((c) => {
            const d = typeDef(c.type);
            return (
              <Card key={c.id} withBorder radius="md" padding="lg">
                <Group justify="space-between" mb="xs">
                  <Group gap="xs">
                    <ThemeIcon variant="light" color="navy" radius="md"><IconPlugConnected size={18} /></ThemeIcon>
                    <div>
                      <Text fw={600}>{c.label}</Text>
                      <Text size="xs" c="dimmed">{d?.label ?? c.type}</Text>
                    </div>
                  </Group>
                  <Menu withinPortal position="bottom-end">
                    <Menu.Target>
                      <ActionIcon variant="subtle" color="gray" aria-label={`Actions for ${c.label}`}><IconDots size={18} /></ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item leftSection={<IconPlugConnectedX size={14} />} onClick={() => test(c)}>Test</Menu.Item>
                      <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => openEdit(c)}>Edit / rotate</Menu.Item>
                      <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => setConfirmDelete(c)}>Delete</Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </Group>
                <Group gap={6} mb="xs">
                  <Badge size="sm" color={STATUS_COLOR[c.status ?? 'unknown']} variant="light">{c.status ?? 'unknown'}</Badge>
                  {c.secretFields.map((f) => <Badge key={f} size="sm" variant="outline" color="teal">🔑 {f}</Badge>)}
                </Group>
                {c.statusMessage && (
                  <Text size="xs" c={c.status === 'error' ? 'red.7' : 'dimmed'} mb={4}>{c.statusMessage}</Text>
                )}
                {Object.entries(c.config).map(([k, v]) => (
                  <Text key={k} size="xs" c="dimmed" truncate>{k}: {v}</Text>
                ))}
                <Button mt="md" size="xs" variant="light" fullWidth loading={testing === c.id} onClick={() => test(c)}>Test connection</Button>
              </Card>
            );
          })}
        </SimpleGrid>
      )}

      <Modal opened={opened} onClose={close} title={editId ? 'Edit integration' : 'Add integration'} size="md">
        <Stack>
          <Select
            label="Type"
            data={TYPES.map((t) => ({ value: t.value, label: t.label }))}
            value={type}
            onChange={(v) => v && setType(v)}
            disabled={!!editId}
            allowDeselect={false}
          />
          {def && <Text size="xs" c="dimmed">{def.hint}</Text>}
          <TextInput label="Label" placeholder={def?.label} required value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
          {def?.config.map((f) => (
            <TextInput
              key={f.key}
              label={f.label}
              placeholder={f.placeholder}
              value={config[f.key] ?? ''}
              onChange={(e) => setConfig({ ...config, [f.key]: e.currentTarget.value })}
            />
          ))}
          {def?.secrets.map((f) => (
            <PasswordInput
              key={f.key}
              label={f.label}
              placeholder={editId ? 'leave blank to keep current' : ''}
              value={secrets[f.key] ?? ''}
              onChange={(e) => setSecrets({ ...secrets, [f.key]: e.currentTarget.value })}
            />
          ))}
          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={close}>Cancel</Button>
            <Button onClick={save}>Save</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete integration?" size="sm">
        <Stack>
          <Text size="sm">
            Delete <b>{confirmDelete?.label}</b>? Its stored credentials will be purged from {secretHome}. This cannot be undone.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button color="red" onClick={() => confirmDelete && remove(confirmDelete)}>Delete</Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
