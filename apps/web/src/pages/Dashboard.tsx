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
import type { OverviewRow } from '../types.js';
import { RatingBadge, StatusBadge } from '../ui.js';

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
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [period, setPeriod] = useState('');
  const [integrations, setIntegrations] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    Promise.all([api.overview(), api.listIntegrations()])
      .then(([o, i]) => {
        if (!live) return;
        setRows(o.clients);
        setPeriod(o.currentPeriod);
        setIntegrations(i.integrations.length);
      })
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  const chartData = rows
    .filter((r) => r.score !== null)
    .map((r) => ({ name: r.name.length > 16 ? r.name.slice(0, 15) + '…' : r.name, score: r.score }));
  // YYYY-QN ids sort lexicographically, so the max is the newest scored quarter.
  const dataThrough = rows.map((r) => r.period).filter(Boolean).sort().at(-1);

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <Title order={2}>Dashboard</Title>
        <Text c="dimmed">{period && `Current period ${period}`}</Text>
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <StatCard icon={<IconUsers size={24} />} label="QBR clients" value={rows.length} />
        <StatCard icon={<IconPlugConnected size={24} />} label="Integrations" value={integrations} />
        <StatCard
          icon={<IconCalendarStats size={24} />}
          label="Current quarter"
          value={
            <>
              {period || '—'}
              {dataThrough && dataThrough !== period && (
                <Text span size="xs" c="dimmed" ml={8}>data through {dataThrough}</Text>
              )}
            </>
          }
        />
      </SimpleGrid>

      <Card withBorder radius="md" padding="lg">
        <Title order={4} mb="md">Security maturity by client</Title>
        {loading ? (
          <Center h={200}><Loader /></Center>
        ) : chartData.length === 0 ? (
          <Text c="dimmed" size="sm">No scored QBRs yet. Import clients, enable QBR on the ones you review, and run a Sync.</Text>
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
        <Title order={4} mb="md">QBR clients</Title>
        {loading ? (
          <Center h={120}><Loader /></Center>
        ) : rows.length === 0 ? (
          <Text c="dimmed" size="sm">No QBR-enabled clients yet — flip the QBR toggle on the Clients page.</Text>
        ) : (
          <Table highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Client</Table.Th>
                <Table.Th>Industry</Table.Th>
                <Table.Th>Maturity</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((r) => (
                <Table.Tr key={r.clientId}>
                  <Table.Td>
                    <Anchor component={Link} to={`/clients/${r.clientId}`} fw={600}>{r.name}</Anchor>
                  </Table.Td>
                  <Table.Td>{r.industry ?? '—'}</Table.Td>
                  <Table.Td>{r.period ? <RatingBadge rating={r.rating} score={r.score} /> : <Text size="sm" c="dimmed">no data</Text>}</Table.Td>
                  <Table.Td><StatusBadge status={r.status} /></Table.Td>
                  <Table.Td ta="right">
                    <Button component={Link} to={`/clients/${r.clientId}`} size="xs" variant="subtle" rightSection={<IconArrowRight size={14} />}>
                      Open
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Card>
    </Stack>
  );
}
