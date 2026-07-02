import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  SimpleGrid,
  Card,
  Text,
  Group,
  Title,
  ThemeIcon,
  Table,
  Anchor,
  Loader,
  Center,
  Stack,
  Button,
} from '@mantine/core';
import { BarChart } from '@mantine/charts';
import { IconUsers, IconPlugConnected, IconCalendarStats, IconArrowRight } from '@tabler/icons-react';
import { api } from '../api.js';
import type { Client } from '../types.js';
import { RatingBadge } from '../ui.js';

interface Row {
  client: Client;
  score: number | null;
  rating: 'green' | 'amber' | 'red' | 'unknown';
  period: string;
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <Card withBorder padding="lg" radius="md">
      <Group>
        <ThemeIcon size={44} radius="md" variant="light" color="navy">
          {icon}
        </ThemeIcon>
        <div>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>{label}</Text>
          <Text fw={700} size="xl">{value}</Text>
        </div>
      </Group>
    </Card>
  );
}

export function Dashboard() {
  const [clients, setClients] = useState<Client[]>([]);
  const [period, setPeriod] = useState('');
  const [integrations, setIntegrations] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    (async () => {
      const [{ clients }, { integrations }, { period }] = await Promise.all([
        api.listClients(),
        api.listIntegrations(),
        api.currentPeriod(),
      ]);
      if (!live) return;
      setClients(clients);
      setIntegrations(integrations.length);
      setPeriod(period);

      // Pull each client's maturity for the current (or seed) period; skip those without data.
      const tryPeriods = [period, '2026-Q1', '2025-Q4'];
      const built = await Promise.all(
        clients.map(async (client) => {
          for (const p of tryPeriods) {
            try {
              const qbr = await api.getQbr(client.id, p, false);
              return { client, score: qbr.model.scorecard.overall.score, rating: qbr.model.scorecard.overall.rating, period: p };
            } catch {
              /* no data for this period — try the next */
            }
          }
          return null;
        }),
      );
      if (!live) return;
      setRows(built.filter((r): r is Row => r !== null));
      setLoading(false);
    })().catch(() => setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  const chartData = rows
    .filter((r) => r.score !== null)
    .map((r) => ({ name: r.client.name.length > 16 ? r.client.name.slice(0, 15) + '…' : r.client.name, score: r.score }));

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <Title order={2}>Dashboard</Title>
        <Text c="dimmed">{period && `Current period ${period}`}</Text>
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <StatCard icon={<IconUsers size={24} />} label="Clients" value={clients.length} />
        <StatCard icon={<IconPlugConnected size={24} />} label="Integrations" value={integrations} />
        <StatCard icon={<IconCalendarStats size={24} />} label="Quarter" value={period || '—'} />
      </SimpleGrid>

      <Card withBorder radius="md" padding="lg">
        <Title order={4} mb="md">Security maturity by client</Title>
        {loading ? (
          <Center h={200}><Loader /></Center>
        ) : chartData.length === 0 ? (
          <Text c="dimmed" size="sm">No scored QBRs yet. Import clients and run a sync to populate maturity.</Text>
        ) : (
          <BarChart
            h={260}
            data={chartData}
            dataKey="name"
            series={[{ name: 'score', label: 'Maturity', color: 'navy.7' }]}
            yAxisProps={{ domain: [0, 100] }}
            barProps={{ radius: 4 }}
            withLegend={false}
          />
        )}
      </Card>

      <Card withBorder radius="md" padding="lg">
        <Title order={4} mb="md">Clients</Title>
        {loading ? (
          <Center h={120}><Loader /></Center>
        ) : (
          <Table highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Client</Table.Th>
                <Table.Th>Industry</Table.Th>
                <Table.Th>Maturity</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {clients.map((c) => {
                const row = rows.find((r) => r.client.id === c.id);
                return (
                  <Table.Tr key={c.id}>
                    <Table.Td>
                      <Anchor component={Link} to={`/clients/${c.id}`} fw={600}>{c.name}</Anchor>
                    </Table.Td>
                    <Table.Td>{c.industry ?? '—'}</Table.Td>
                    <Table.Td>{row ? <RatingBadge rating={row.rating} score={row.score} /> : <Text size="sm" c="dimmed">no data</Text>}</Table.Td>
                    <Table.Td ta="right">
                      <Button component={Link} to={`/clients/${c.id}`} size="xs" variant="subtle" rightSection={<IconArrowRight size={14} />}>
                        Open
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      </Card>
    </Stack>
  );
}
