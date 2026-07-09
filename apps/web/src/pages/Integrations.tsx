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
  MultiSelect,
  Select,
  TextInput,
  Textarea,
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
import { IconPlus, IconDots, IconPlugConnected, IconTrash, IconPlugConnectedX, IconPencil, IconRoute } from '@tabler/icons-react';
import { List, Anchor } from '@mantine/core';
import { api, type ConnectionInput } from '../api.js';
import type { Client, ConnectionView, HaloMeta, SystemInfo } from '../types.js';

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
  /** Show a "dedicated to client" selector (per-tenant credentials). */
  perClient?: 'required' | 'optional';
  /** Secret fields rendered as multi-line inputs (e.g. pasted JSON keys). */
  multilineSecrets?: string[];
  /** Step-by-step setup instructions rendered in the modal. */
  setupSteps?: string[];
  setupLink?: { label: string; href: string };
  /** Hidden from the Add picker (existing connections still render). */
  legacy?: boolean;
}

// Field keys align exactly with what the server pipeline reads (see
// integrationsService.ts / actions.ts / handlers.resolveMcp).
const TYPES: TypeDef[] = [
  {
    value: 'halo',
    label: 'HaloPSA',
    hint: 'Tickets, contracts & invoices (MRR/spend), and ticket push. Create an API application in Halo (Client Credentials, scope "all") and paste its ID + Secret.',
    config: [
      { key: 'baseUrl', label: 'Instance URL', placeholder: 'https://mashit.halopsa.com' },
      { key: 'clientId', label: 'Client ID' },
      { key: 'tenant', label: 'Tenant (optional — hosted instances only)', placeholder: 'mashit' },
    ],
    secrets: [{ key: 'clientSecret', label: 'Client Secret' }],
  },
  {
    value: 'ninja',
    label: 'NinjaOne',
    hint: 'Devices, AV coverage, patching & backup. Create an API client (client credentials, "monitoring" scope) under Administration → Apps → API.',
    config: [
      { key: 'baseUrl', label: 'Region URL', placeholder: 'https://app.ninjarmm.com' },
      { key: 'clientId', label: 'Client ID' },
    ],
    secrets: [{ key: 'clientSecret', label: 'Client Secret' }],
  },
  {
    value: 'hudu',
    label: 'Hudu',
    hint: 'Documented assets + warranty/domain/SSL expirations. Create an API key under Admin → API.',
    config: [{ key: 'baseUrl', label: 'Instance URL', placeholder: 'https://mashit.huducloud.com' }],
    secrets: [{ key: 'apiKey', label: 'API Key' }],
  },
  {
    value: 'huntress',
    label: 'Huntress',
    hint: 'EDR / ITDR / SAT posture + the quarterly summary report',
    config: [{ key: 'baseUrl', label: 'Base URL (includes /v1)', placeholder: 'https://api.huntress.io/v1' }],
    secrets: [
      { key: 'apiKey', label: 'API Key' },
      { key: 'apiSecret', label: 'API Secret' },
    ],
  },
  {
    value: 'checkpoint',
    label: 'Check Point HEC',
    hint: 'Email security & DLP. Infinity Portal API keys are per-tenant — create the key inside the client\'s tenant and dedicate this connection to that client below. (For the richer report data, forward the emailed Check Point report to the client\'s report inbox instead.)',
    perClient: 'optional',
    config: [
      { key: 'baseUrl', label: 'SMART API base URL', placeholder: 'https://smart-api-production-1-us.avanan.net' },
      { key: 'clientId', label: 'Infinity Portal Client ID' },
      { key: 'authUrl', label: 'Auth gateway (optional — region override)', placeholder: 'https://cloudinfra-gw-us.portal.checkpoint.com/auth/external' },
    ],
    secrets: [{ key: 'accessKey', label: 'Access Key' }],
  },
  {
    value: 'cipp',
    label: 'CIPP (Microsoft 365)',
    hint: 'M365 posture per tenant: MFA registration, user counts, Conditional Access, licenses. Uses the CIPP-API app registration (client credentials).',
    config: [
      { key: 'baseUrl', label: 'CIPP instance URL', placeholder: 'https://cipp.mashit.net' },
      { key: 'tenantId', label: 'Entra tenant ID (your MSP tenant)' },
      { key: 'clientId', label: 'CIPP-API application (client) ID' },
    ],
    secrets: [{ key: 'clientSecret', label: 'Client Secret' }],
  },
  {
    value: 'googleworkspace',
    label: 'Google Workspace',
    hint: 'Read-only Directory access for a Google Workspace client: users + 2-Step Verification coverage. Each connection is dedicated to one QBR client.',
    perClient: 'required',
    setupSteps: [
      'In Google Cloud Console (console.cloud.google.com), create (or pick) a project, then APIs & Services → Library → enable the "Admin SDK API".',
      'IAM & Admin → Service Accounts → Create service account (no roles needed). Open it → Keys → Add key → JSON — download the key file.',
      'Copy the service account\'s "Unique ID" (client ID) from its details page.',
      'In the CLIENT\'s Google Admin console (admin.google.com): Security → Access and data control → API controls → Manage domain-wide delegation → Add new — paste the client ID and the scope: https://www.googleapis.com/auth/admin.directory.user.readonly',
      'Enter a super-admin email from the client\'s domain below (the account the service impersonates, read-only), and paste the whole JSON key file into the secret field.',
    ],
    setupLink: { label: 'Google\'s domain-wide delegation guide', href: 'https://developers.google.com/workspace/guides/create-credentials#service-account' },
    config: [
      { key: 'adminEmail', label: 'Workspace admin email (impersonated)', placeholder: 'admin@client.com' },
      { key: 'customer', label: 'Customer ID (optional — defaults to the admin\'s domain)', placeholder: 'my_customer' },
    ],
    secrets: [{ key: 'serviceAccountJson', label: 'Service-account JSON key (paste the whole file)' }],
    multilineSecrets: ['serviceAccountJson'],
  },
  {
    value: 'dropsuite',
    label: 'Dropsuite',
    hint: 'Email/M365 backup coverage & health (sub-reseller API, read-only). Both tokens come from your Dropsuite reseller portal.',
    config: [{ key: 'baseUrl', label: 'API base URL', placeholder: 'https://dropsuite.us/api' }],
    secrets: [
      { key: 'resellerToken', label: 'Reseller token (X-Reseller-Token)' },
      { key: 'accessToken', label: 'Admin authentication token (X-Access-Token)' },
    ],
  },
  {
    value: 'printix',
    label: 'Printix',
    hint: 'Print fleet size & health. Each client has their OWN Printix tenant — register an API client in THAT tenant\'s admin portal and dedicate this connection to the QBR client (add one connection per client).',
    config: [
      { key: 'tenantId', label: 'Tenant ID (GUID)' },
      { key: 'clientId', label: 'Client ID' },
    ],
    secrets: [{ key: 'clientSecret', label: 'Client Secret' }],
    perClient: 'required',
  },
  {
    value: 'connectsecure',
    label: 'ConnectSecure',
    hint: 'Vulnerability posture (critical/high counts, compliance score) per company.',
    config: [
      { key: 'baseUrl', label: 'Pod URL', placeholder: 'https://pod100.myconnectsecure.com' },
      { key: 'clientId', label: 'Client ID' },
      { key: 'tenant', label: 'Tenant name (optional)' },
    ],
    secrets: [{ key: 'clientSecret', label: 'Client Secret' }],
  },
  {
    value: 'defensx',
    label: 'DefensX',
    hint: 'Web security / DNS filtering / credential & phishing protection. Cyber-resilience score, protected & risky users, risky browser extensions, and blocked malicious/credential-theft sites per customer. Generate an API token on the DefensX portal’s API Keys page, then map each client to a DefensX customer.',
    config: [{ key: 'baseUrl', label: 'API root (optional)', placeholder: 'https://cloud.defensx.com/api/partner/v1' }],
    secrets: [{ key: 'token', label: 'API token (Authorization: Bearer)' }],
  },
  {
    value: 'zomentum',
    label: 'Zomentum',
    hint: 'Push opportunities',
    config: [{ key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.zomentum.com' }],
    secrets: [{ key: 'token', label: 'API bearer token' }],
  },
  {
    value: 'mcp',
    label: 'MASH MCP (legacy)',
    hint: 'Legacy path — replaced by the direct HaloPSA/NinjaOne/Hudu connections above. Existing MCP connections keep working until deleted.',
    legacy: true,
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
];

const typeDef = (t: string) => TYPES.find((d) => d.value === t);
const STATUS_COLOR: Record<string, string> = { ok: 'teal', error: 'red', unknown: 'gray' };
/** Which integrationRefs key a connection type maps to (mirrors the server). */
const REF_KEY: Record<string, string> = { mcp: 'halo' };

/** Modal that maps QBR clients to their ids inside one tool. */
function MappingModal({ conn, onClose }: { conn: ConnectionView; onClose: (saved: boolean) => void }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string }> | null>(null);
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const refKey = REF_KEY[conn.type] ?? conn.type;

  useEffect(() => {
    let live = true;
    Promise.all([
      api.listClients(),
      api.integrationOrgs(conn.id).catch((e: unknown) => {
        if (live) setOrgError(e instanceof Error ? e.message : 'Could not list organizations');
        return { orgs: null };
      }),
    ])
      .then(([c, o]) => {
        if (!live) return;
        const qbrClients = c.clients.filter((x) => x.qbrEnabled !== false);
        setClients(qbrClients);
        // An empty org list means the tool answered but nothing was readable —
        // fall back to free-text ids rather than show unusable empty dropdowns.
        if (o.orgs && o.orgs.length === 0) {
          setOrgs(null);
          setOrgError('The tool responded but no organizations could be read — enter each client’s id manually.');
        } else {
          setOrgs(o.orgs);
        }
        setRefs(Object.fromEntries(qbrClients.map((x) => [x.id, x.integrationRefs?.[refKey] ?? ''])));
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [conn.id, refKey]);

  async function save() {
    setSaving(true);
    try {
      const { updated } = await api.putMappings(conn.id, Object.entries(refs).map(([clientId, externalRef]) => ({ clientId, externalRef })));
      notifications.show({ color: 'teal', message: `Mapped ${updated} client(s) for ${conn.label}.` });
      onClose(true);
    } catch (e) {
      notifications.show({ color: 'red', title: 'Save failed', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setSaving(false);
    }
  }

  const orgOptions = (orgs ?? []).map((o) => ({ value: o.id, label: `${o.name} (${o.id})` }));
  // Keep previously saved ids visible even if they aren't in the tool's list.
  for (const v of Object.values(refs).flatMap((s) => s.split(',').map((x) => x.trim()).filter(Boolean))) {
    if (!orgOptions.some((o) => o.value === v)) orgOptions.push({ value: v, label: `${v} (saved)` });
  }
  // Halo clients sometimes split into service + billing entities — allow
  // mapping one QBR client to several Halo ids (tallies are summed on sync).
  const multi = conn.type === 'halo';

  return (
    <Modal opened onClose={() => onClose(false)} title={`Map clients — ${conn.label}`} size="lg">
      <Stack>
        <Text size="sm" c="dimmed">
          Match each QBR client to its record in {typeDef(conn.type)?.label ?? conn.type}
          {orgs
            ? ' — pick from the organizations found in the tool.'
            : ` — the tool's organization list couldn't be loaded, so type each client's ${typeDef(conn.type)?.label ?? conn.type} id manually (or fix the connection and reopen).`}
          {multi && ' You can pick multiple Halo entities per client (e.g. a service + a billing entity) — their numbers are combined.'}
        </Text>
        {orgError && <Text size="sm" c="red.7">{orgError}</Text>}
        {loading ? (
          <Center h={120}><Loader /></Center>
        ) : clients.length === 0 ? (
          <Text size="sm" c="dimmed">No QBR-enabled clients yet — enable some on the Clients page first.</Text>
        ) : (
          clients.map((c) => (
            <Group key={c.id} wrap="nowrap" align="center">
              <Text size="sm" fw={600} w={220} truncate>{c.name}</Text>
              {orgs && multi ? (
                <MultiSelect
                  style={{ flex: 1 }}
                  placeholder={refs[c.id] ? undefined : 'Not mapped'}
                  data={orgOptions}
                  value={(refs[c.id] ?? '').split(',').map((s) => s.trim()).filter(Boolean)}
                  onChange={(vals) => setRefs({ ...refs, [c.id]: vals.join(',') })}
                  searchable
                  clearable
                  aria-label={`Map ${c.name}`}
                />
              ) : orgs ? (
                <Select
                  style={{ flex: 1 }}
                  placeholder="Not mapped"
                  data={orgOptions}
                  value={refs[c.id] || null}
                  onChange={(v) => setRefs({ ...refs, [c.id]: v ?? '' })}
                  searchable
                  clearable
                  aria-label={`Map ${c.name}`}
                />
              ) : (
                <TextInput
                  style={{ flex: 1 }}
                  placeholder={`${conn.type} id`}
                  value={refs[c.id] ?? ''}
                  onChange={(e) => setRefs({ ...refs, [c.id]: e.currentTarget.value })}
                  aria-label={`Map ${c.name}`}
                />
              )}
            </Group>
          ))
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={() => onClose(false)}>Cancel</Button>
          <Button loading={saving} onClick={save} disabled={clients.length === 0}>Save mappings</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function Integrations() {
  const [conns, setConns] = useState<ConnectionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [opened, { open, close }] = useDisclosure(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ConnectionView | null>(null);
  const [mapping, setMapping] = useState<ConnectionView | null>(null);
  const [qbrClients, setQbrClients] = useState<Client[]>([]);
  const secretHome = system?.secretStore === 'keyvault' ? 'Azure Key Vault' : 'the local secret file (dev)';

  const [editId, setEditId] = useState<string | undefined>();
  const [type, setType] = useState('halo');
  const [label, setLabel] = useState('');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [haloMeta, setHaloMeta] = useState<HaloMeta | null>(null);
  const [haloMetaLoading, setHaloMetaLoading] = useState(false);
  const [ninjaRoles, setNinjaRoles] = useState<Array<{ id: string; name: string }> | null>(null);
  const [ninjaRolesLoading, setNinjaRolesLoading] = useState(false);

  // Ticket-type picker data for Halo connections (needs saved, working creds).
  // Scoped to the connection being edited so a second Halo instance's ids
  // can't leak into this one's config.
  useEffect(() => {
    if (!opened || type !== 'halo' || !editId) return;
    let live = true;
    setHaloMeta(null);
    setHaloMetaLoading(true);
    api
      .haloMeta(editId)
      .then((m) => live && setHaloMeta(m))
      .catch(() => live && setHaloMeta(null))
      .finally(() => live && setHaloMetaLoading(false));
    return () => {
      live = false;
    };
  }, [opened, type, editId]);

  // Device-role picker data for NinjaOne connections (same pattern).
  useEffect(() => {
    if (!opened || type !== 'ninja' || !editId) return;
    let live = true;
    setNinjaRoles(null);
    setNinjaRolesLoading(true);
    api
      .ninjaMeta(editId)
      .then((m) => live && setNinjaRoles(m.roles))
      .catch(() => live && setNinjaRoles(null))
      .finally(() => live && setNinjaRolesLoading(false));
    return () => {
      live = false;
    };
  }, [opened, type, editId]);

  const load = () => api.listIntegrations().then((d) => setConns(d.integrations)).finally(() => setLoading(false));
  useEffect(() => {
    load();
    api.system().then(setSystem).catch(() => {});
    api.listClients().then((d) => setQbrClients(d.clients.filter((c) => c.qbrEnabled !== false))).catch(() => {});
  }, []);

  function openNew() {
    setEditId(undefined);
    setType('halo');
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
    if (typeDef(type)?.perClient === 'required' && !config['qbrClientId']) {
      notifications.show({ color: 'red', message: 'Pick the QBR client this connection belongs to.' });
      return;
    }
    const input: ConnectionInput = { type, label, config, secrets };
    const savedSecrets = Object.values(secrets).some((v) => v && v.length > 0);
    try {
      if (editId) {
        await api.updateIntegration(editId, input);
        close();
      } else {
        const created = await api.createIntegration(input);
        // Halo/Ninja scoping pickers (ticket types, device roles) need a saved
        // connection to fetch against — flip straight into Edit so the user can
        // scope now instead of save → reopen.
        if (type === 'halo' || type === 'ninja') {
          setEditId(created.id);
          setSecrets({});
          notifications.show({ color: 'teal', message: `Saved ${label} — pick the scoping below, then Save again.` });
          await load();
          return;
        }
        close();
      }
      notifications.show({ color: 'teal', message: `Saved ${label}.${savedSecrets ? ` Secrets stored in ${secretHome}.` : ''}` });
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
              <Text c="dimmed" size="sm">Connect HaloPSA, NinjaOne, Hudu, Huntress, Check Point, Dropsuite, Printix and ConnectSecure directly with their API credentials.</Text>
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
                      <Menu.Item leftSection={<IconRoute size={14} />} onClick={() => setMapping(c)}>Map clients</Menu.Item>
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
                <Group mt="md" grow>
                  <Button size="xs" variant="light" loading={testing === c.id} onClick={() => test(c)}>Test connection</Button>
                  <Button size="xs" variant="default" leftSection={<IconRoute size={14} />} onClick={() => setMapping(c)}>Map clients</Button>
                </Group>
              </Card>
            );
          })}
        </SimpleGrid>
      )}

      <Modal opened={opened} onClose={close} title={editId ? 'Edit integration' : 'Add integration'} size="md">
        <Stack>
          <Select
            label="Type"
            data={TYPES.filter((t) => !t.legacy || t.value === type).map((t) => ({ value: t.value, label: t.label }))}
            value={type}
            onChange={(v) => v && setType(v)}
            disabled={!!editId}
            allowDeselect={false}
          />
          {def && <Text size="xs" c="dimmed">{def.hint}</Text>}
          {def?.setupSteps && (
            <div>
              <Text size="xs" fw={600} mb={4}>Setup</Text>
              <List type="ordered" size="xs" spacing={4} c="dimmed">
                {def.setupSteps.map((s, i) => <List.Item key={i}>{s}</List.Item>)}
              </List>
              {def.setupLink && (
                <Anchor href={def.setupLink.href} target="_blank" size="xs">{def.setupLink.label} ↗</Anchor>
              )}
            </div>
          )}
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
          {def?.perClient && (
            <Select
              label={def.perClient === 'required' ? 'Dedicated to QBR client' : 'Dedicated to QBR client (optional — blank = shared)'}
              placeholder="Pick a client"
              data={qbrClients.map((c) => ({ value: c.id, label: c.name }))}
              value={config['qbrClientId'] || null}
              onChange={(v) => setConfig({ ...config, qbrClientId: v ?? '' })}
              searchable
              clearable={def.perClient === 'optional'}
            />
          )}
          {type === 'halo' &&
            (editId && haloMeta ? (
              <MultiSelect
                label="Ticket types to report on (blank = all)"
                description="Only these ticket types count toward the QBR's ticket volumes and SLA."
                data={haloMeta.ticketTypes.map((t) => ({ value: t.id, label: t.name }))}
                value={(config['ticketTypeIds'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)}
                onChange={(vals) => setConfig({ ...config, ticketTypeIds: vals.join(',') })}
                searchable
                clearable
              />
            ) : editId && haloMetaLoading ? (
              <Text size="xs" c="dimmed">
                Loading ticket types from Halo…
              </Text>
            ) : (
              <Text size="xs" c="dimmed">
                {editId
                  ? 'Ticket-type picker unavailable — check the connection credentials, then reopen Edit.'
                  : 'Save the connection first, then reopen Edit to choose which ticket types count toward the QBR.'}
              </Text>
            ))}
          {type === 'ninja' &&
            (editId && ninjaRoles ? (
              <MultiSelect
                label="Device roles to report on (blank = all)"
                description="Only devices with these roles (Windows Desktop, Windows Laptop, Mac…) count toward device, patch, AV and backup metrics."
                data={ninjaRoles.map((r) => ({ value: r.id, label: r.name }))}
                value={(config['nodeRoleIds'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)}
                onChange={(vals) => setConfig({ ...config, nodeRoleIds: vals.join(',') })}
                searchable
                clearable
              />
            ) : editId && ninjaRolesLoading ? (
              <Text size="xs" c="dimmed">
                Loading device roles from NinjaOne…
              </Text>
            ) : (
              <Text size="xs" c="dimmed">
                {editId
                  ? 'Device-role picker unavailable — check the connection credentials, then reopen Edit.'
                  : 'Save the connection first, then reopen Edit to choose which device roles count toward the QBR.'}
              </Text>
            ))}
          {def?.secrets.map((f) =>
            def.multilineSecrets?.includes(f.key) ? (
              <Textarea
                key={f.key}
                label={f.label}
                placeholder={editId ? 'leave blank to keep current' : '{ "type": "service_account", ... }'}
                autosize
                minRows={3}
                maxRows={6}
                value={secrets[f.key] ?? ''}
                onChange={(e) => setSecrets({ ...secrets, [f.key]: e.currentTarget.value })}
              />
            ) : (
              <PasswordInput
                key={f.key}
                label={f.label}
                placeholder={editId ? 'leave blank to keep current' : ''}
                value={secrets[f.key] ?? ''}
                onChange={(e) => setSecrets({ ...secrets, [f.key]: e.currentTarget.value })}
              />
            ),
          )}
          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={close}>Cancel</Button>
            <Button onClick={save}>Save</Button>
          </Group>
        </Stack>
      </Modal>

      {mapping && <MappingModal conn={mapping} onClose={() => setMapping(null)} />}

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
