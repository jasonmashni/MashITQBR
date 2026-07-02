import { useEffect, useMemo, useState } from 'react';
import { Title, Card, Table, Text, Group, TextInput, Select, Stack, Loader, Center, Badge, Button } from '@mantine/core';
import { IconRefresh, IconSearch } from '@tabler/icons-react';
import { api } from '../api.js';
import type { AuditEvent } from '../types.js';

const ACTION_COLOR: Record<string, string> = {
  'integration.save': 'blue',
  'integration.delete': 'red',
  'integration.test': 'gray',
  'client.update': 'blue',
  'client.import': 'teal',
  'qbr.sync': 'teal',
  'qbr.status': 'grape',
  'qbr.schedule': 'grape',
  'config.save': 'blue',
  'discussion.save': 'blue',
  'action.push': 'green',
};

export function Audit() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [action, setAction] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api
      .audit(200)
      .then((d) => setEvents(d.events))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const actions = useMemo(() => [...new Set(events.map((e) => e.action))].sort(), [events]);
  const filtered = events.filter((e) => {
    if (action && e.action !== action) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return [e.actor, e.action, e.target, e.detail ?? ''].some((f) => f.toLowerCase().includes(q));
  });

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <div>
          <Title order={2}>Audit log</Title>
          <Text c="dimmed" size="sm">Every change — who, what, and when — for compliance review.</Text>
        </div>
        <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={load}>Refresh</Button>
      </Group>

      <Card withBorder radius="md" padding="lg">
        <Group mb="md">
          <TextInput
            placeholder="Search actor, target, detail…"
            leftSection={<IconSearch size={16} />}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <Select placeholder="All actions" data={actions} value={action} onChange={setAction} clearable w={220} />
        </Group>

        {loading ? (
          <Center h={160}><Loader /></Center>
        ) : filtered.length === 0 ? (
          <Text c="dimmed" size="sm">No audit entries{query || action ? ' match the filter' : ' yet — actions will appear here as you work'}.</Text>
        ) : (
          <Table highlightOnHover verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>When</Table.Th>
                <Table.Th>Actor</Table.Th>
                <Table.Th>Action</Table.Th>
                <Table.Th>Target</Table.Th>
                <Table.Th>Detail</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {filtered.map((e) => (
                <Table.Tr key={e.id + e.at}>
                  <Table.Td><Text size="sm" style={{ whiteSpace: 'nowrap' }}>{new Date(e.at).toLocaleString()}</Text></Table.Td>
                  <Table.Td><Text size="sm">{e.actor}</Text></Table.Td>
                  <Table.Td><Badge size="sm" variant="light" color={ACTION_COLOR[e.action] ?? 'gray'}>{e.action}</Badge></Table.Td>
                  <Table.Td><Text size="sm" ff="monospace">{e.target}</Text></Table.Td>
                  <Table.Td><Text size="sm" c="dimmed" lineClamp={1}>{e.detail ?? ''}</Text></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Card>
    </Stack>
  );
}
