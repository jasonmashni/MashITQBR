import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ActionIcon,
  Anchor,
  Badge,
  Card,
  Center,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconFileText, IconFileTypePdf, IconArrowUpRight, IconArrowDownRight, IconCalendarEvent, IconCalendarPlus } from '@tabler/icons-react';
import { api, reportUrls } from '../api.js';
import type { OverviewRow } from '../types.js';
import { RatingBadge, StatusBadge } from '../ui.js';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function SpendDelta({ pct }: { pct: number | null }) {
  if (pct === null) return <Text size="sm" c="dimmed">—</Text>;
  const up = pct > 0;
  const flat = Math.abs(pct) < 0.05;
  if (flat) return <Text size="sm" c="dimmed">flat</Text>;
  return (
    <Group gap={2} wrap="nowrap">
      {up ? <IconArrowUpRight size={15} color="var(--mantine-color-red-7)" /> : <IconArrowDownRight size={15} color="var(--mantine-color-teal-7)" />}
      <Text size="sm" fw={600} c={up ? 'red.7' : 'teal.7'}>
        {up ? '+' : ''}
        {pct}%
      </Text>
    </Group>
  );
}

/**
 * The admin cockpit: every QBR client with the things that actually drive the
 * day — last QBR + workflow state, maturity rating, MRR, spend movement, and
 * attention flags. One click lands in the client workspace.
 */
export function Dashboard() {
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [period, setPeriod] = useState('');
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    let live = true;
    api
      .overview()
      .then((o) => {
        if (!live) return;
        setRows(o.clients);
        setPeriod(o.currentPeriod);
      })
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  const totalMrr = rows.reduce((sum, r) => sum + (r.mrr ?? 0), 0);
  const flagged = rows.filter((r) => r.flags.length > 0).length;

  // The QBR calendar at a glance: what's booked vs what still needs a date.
  // A past meetingAt is still booked — it must not read as "needs scheduling".
  const now = Date.now();
  const done = new Set(['completed', 'dispositioned', 'actions_pushed', 'archived']);
  const upcoming = rows
    .filter((r) => r.meetingAt && Date.parse(r.meetingAt) >= now && r.status !== 'archived')
    .sort((a, b) => Date.parse(a.meetingAt!) - Date.parse(b.meetingAt!));
  const toSchedule = rows.filter((r) => r.period && !r.meetingAt && !done.has(r.status ?? ''));
  const when = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) +
    ' · ' +
    new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>Dashboard</Title>
          <Text c="dimmed" size="sm">
            {period && `Current period ${period}`}
            {totalMrr > 0 && ` · ${money(totalMrr)} MRR across QBR clients`}
            {flagged > 0 && ` · ${flagged} client${flagged === 1 ? '' : 's'} flagged`}
          </Text>
        </div>
      </Group>

      {!loading && rows.length > 0 && (
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <Card withBorder radius="md" padding="lg">
            <Group gap="xs" mb="xs">
              <IconCalendarEvent size={18} color="var(--mantine-color-teal-7)" />
              <Text fw={600}>Upcoming QBRs</Text>
            </Group>
            {upcoming.length === 0 ? (
              <Text size="sm" c="dimmed">Nothing on the calendar.</Text>
            ) : (
              <Stack gap={6}>
                {upcoming.map((r) => (
                  <Group key={r.clientId} justify="space-between" wrap="nowrap">
                    <Anchor component={Link} to={`/clients/${r.clientId}`} size="sm" fw={600}>{r.name}</Anchor>
                    <Text size="sm" c="dimmed">{when(r.meetingAt!)}</Text>
                  </Group>
                ))}
              </Stack>
            )}
          </Card>
          <Card withBorder radius="md" padding="lg">
            <Group gap="xs" mb="xs">
              <IconCalendarPlus size={18} color="var(--mantine-color-yellow-7)" />
              <Text fw={600}>Needs scheduling</Text>
            </Group>
            {toSchedule.length === 0 ? (
              <Text size="sm" c="dimmed">Every active QBR has a meeting booked.</Text>
            ) : (
              <Stack gap={6}>
                {toSchedule.map((r) => (
                  <Group key={r.clientId} justify="space-between" wrap="nowrap">
                    <Anchor component={Link} to={`/clients/${r.clientId}`} size="sm" fw={600}>{r.name}</Anchor>
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm" c="dimmed">{r.period}</Text>
                      <StatusBadge status={r.status} />
                    </Group>
                  </Group>
                ))}
              </Stack>
            )}
          </Card>
        </SimpleGrid>
      )}

      <Card withBorder radius="md" padding="lg">
        {loading ? (
          <Center h={160}>
            <Loader />
          </Center>
        ) : rows.length === 0 ? (
          <Text c="dimmed" size="sm">
            No QBR-enabled clients yet — flip the QBR toggle on the Clients page.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={860}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Client</Table.Th>
                  <Table.Th>Last QBR</Table.Th>
                  <Table.Th>Maturity</Table.Th>
                  <Table.Th ta="right">MRR</Table.Th>
                  <Table.Th>Spend Δ QoQ</Table.Th>
                  <Table.Th>Flags</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((r) => {
                  const urls = r.period ? reportUrls(r.clientId, r.period) : null;
                  return (
                    <Table.Tr key={r.clientId} style={{ cursor: 'pointer' }} onClick={() => navigate(`/clients/${r.clientId}`)}>
                      <Table.Td>
                        <Anchor component={Link} to={`/clients/${r.clientId}`} fw={600} onClick={(e) => e.stopPropagation()}>
                          {r.name}
                        </Anchor>
                        <Text size="xs" c="dimmed">
                          {r.industry ?? ''}
                          {r.hipaa ? ' · HIPAA' : ''}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {r.period ? (
                          <>
                            <Text size="sm" fw={600}>{r.period}</Text>
                            <Group gap={6} mt={2}>
                              <StatusBadge status={r.status} />
                              {r.meetingAt && (
                                <Text size="xs" c="dimmed">{new Date(r.meetingAt).toLocaleDateString()}</Text>
                              )}
                            </Group>
                          </>
                        ) : (
                          <Text size="sm" c="dimmed">no data — run a Sync</Text>
                        )}
                      </Table.Td>
                      <Table.Td>{r.period ? <RatingBadge rating={r.rating} score={r.score} /> : <Text size="sm" c="dimmed">—</Text>}</Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" fw={600}>{r.mrr !== null ? money(r.mrr) : '—'}</Text>
                      </Table.Td>
                      <Table.Td>
                        <SpendDelta pct={r.spendDeltaPct} />
                        {r.spend !== null && (
                          <Text size="xs" c="dimmed">{money(r.spend)} this qtr</Text>
                        )}
                      </Table.Td>
                      <Table.Td maw={260}>
                        {r.flags.length === 0 ? (
                          <Text size="sm" c="dimmed">—</Text>
                        ) : (
                          <Group gap={4}>
                            {r.flags.map((f) => (
                              <Badge key={f.label} size="sm" variant="light" color={f.severity === 'red' ? 'red' : 'yellow'}>
                                {f.label}
                              </Badge>
                            ))}
                          </Group>
                        )}
                      </Table.Td>
                      <Table.Td ta="right" onClick={(e) => e.stopPropagation()}>
                        {urls && (
                          <Group gap={4} justify="flex-end" wrap="nowrap">
                            <Tooltip label="Open report">
                              <ActionIcon component="a" href={urls.html} target="_blank" variant="subtle" aria-label={`Report for ${r.name}`}>
                                <IconFileText size={17} />
                              </ActionIcon>
                            </Tooltip>
                            <Tooltip label="Download PDF">
                              <ActionIcon component="a" href={urls.pdf} target="_blank" variant="subtle" aria-label={`PDF for ${r.name}`}>
                                <IconFileTypePdf size={17} />
                              </ActionIcon>
                            </Tooltip>
                          </Group>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>
    </Stack>
  );
}
