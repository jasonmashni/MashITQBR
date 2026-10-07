import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ActionIcon,
  Anchor,
  Box,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconFileText, IconFileTypePdf, IconUsers } from '@tabler/icons-react';
import { qbrStatusLabel } from '@mashit/core';
import { api, reportUrls } from '../api.js';
import { compactMoney, money, when } from '../format.js';
import type { AccountHealth, OverviewRow, Triage } from '../types.js';
import { RatingBadge, ratingWord } from '../ui.js';

/**
 * Triage groups in urgency order. The band shows them in this order and the
 * table sorts by it, so the client that most needs a call is always first.
 */
const TRIAGE: Array<{ key: Triage; label: string; color: string; hint: string }> = [
  { key: 'meeting_passed', label: 'Meeting passed, not closed', color: 'var(--qbr-act)', hint: 'The booked time has gone by. Capture the outcome or reschedule.' },
  { key: 'package_not_sent', label: 'Package not sent', color: 'var(--qbr-act)', hint: 'The review happened or was skipped, but the client has no report yet.' },
  { key: 'needs_scheduling', label: 'Needs scheduling', color: 'var(--qbr-watch)', hint: 'Data is in; nothing is on the calendar.' },
  { key: 'not_started', label: 'Not started', color: 'var(--qbr-watch)', hint: 'No data pulled for this quarter yet.' },
  { key: 'meeting_soon', label: 'Meeting this week', color: 'var(--qbr-brand, #004aad)', hint: 'Booked within the next seven days.' },
  { key: 'in_progress', label: 'In progress', color: 'var(--qbr-muted)', hint: 'Booked further out, or between steps.' },
  { key: 'done', label: 'Done', color: 'var(--qbr-good)', hint: 'Closed for this quarter.' },
];
const TRIAGE_RANK = new Map(TRIAGE.map((t, i) => [t.key, i]));
const triageOf = (key: Triage) => TRIAGE.find((t) => t.key === key) ?? TRIAGE[TRIAGE.length - 1]!;

function HealthCell({ health }: { health: AccountHealth }) {
  const color = health.rating === 'green' ? 'good.8' : health.rating === 'amber' ? 'watch.8' : health.rating === 'red' ? 'act.8' : 'slate.7';
  return (
    <Tooltip label={health.drivers.join('. ')} multiline w={280}>
      <Group gap={6} wrap="nowrap">
        <Text size="sm" fw={600} c={color} data-num>
          {health.score}
        </Text>
        <Text size="xs" c="dimmed">{ratingWord(health.rating)}</Text>
      </Group>
    </Tooltip>
  );
}

/** Spend movement is information, not alarm: neutral ink, the flag carries any warning. */
function SpendCell({ pct, spend }: { pct: number | null; spend: number | null }) {
  if (pct === null && spend === null) return <Text size="sm" c="dimmed">—</Text>;
  const flat = pct !== null && Math.abs(pct) < 0.05;
  return (
    <Box>
      <Text size="sm" fw={500} data-num>
        {pct === null ? '—' : flat ? 'flat' : `${pct > 0 ? '+' : ''}${pct}%`}
      </Text>
      {spend !== null && <Text size="xs" c="dimmed" data-num>{money(spend)} this quarter</Text>}
    </Box>
  );
}

/** What this client needs this quarter, in words, with the booked time when there is one. */
function ThisQuarterCell({ r }: { r: OverviewRow }) {
  const t = triageOf(r.triage);
  const meeting = r.current.meetingAt;
  return (
    <Box>
      <Text size="sm" fw={600} style={{ color: t.color }}>{t.label}</Text>
      <Text size="xs" c="dimmed">
        {r.current.hasData ? qbrStatusLabel(r.current.status) : 'No data pulled'}
        {meeting ? `. ${when(meeting)}` : ''}
      </Text>
    </Box>
  );
}

/**
 * The admin cockpit. The band at the top answers the only morning question
 * that matters: who needs something this quarter. The table below carries the
 * detail, sorted by that same urgency.
 */
export function Dashboard() {
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [period, setPeriod] = useState('');
  const [daysLeft, setDaysLeft] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .overview()
      .then((o) => {
        if (!live) return;
        setRows(o.clients);
        setPeriod(o.currentPeriod);
        setDaysLeft(o.quarterEndsInDays ?? null);
        setLoadError(null);
      })
      .catch((e) => live && setLoadError(e instanceof Error ? e.message : 'Request failed'))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [retry]);

  const sorted = [...rows].sort(
    (a, b) => (TRIAGE_RANK.get(a.triage) ?? 99) - (TRIAGE_RANK.get(b.triage) ?? 99) || a.name.localeCompare(b.name),
  );
  const groups = TRIAGE.map((t) => ({ ...t, clients: sorted.filter((r) => r.triage === t.key) })).filter((g) => g.clients.length > 0);
  const needsAction = rows.filter((r) => r.triage !== 'done' && r.triage !== 'in_progress').length;
  const totalMrr = rows.reduce((sum, r) => sum + (r.mrr ?? 0), 0);
  const totalRoadmap = rows.reduce((sum, r) => sum + (r.roadmapValue ?? 0), 0);

  const subtitle = [
    period ? `Current quarter ${period}` : '',
    daysLeft !== null ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : '',
    totalMrr > 0 ? `${money(totalMrr)} MRR across QBR clients` : '',
    totalRoadmap > 0 ? `${compactMoney(totalRoadmap)} roadmap pipeline` : '',
  ].filter(Boolean);

  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>Dashboard</Title>
        {subtitle.length > 0 && (
          <Text c="dimmed" size="sm" mt={2}>
            {subtitle.join('. ')}.
          </Text>
        )}
      </div>

      {!loading && !loadError && rows.length > 0 && (
        <Card padding="lg" style={{ background: 'var(--qbr-surface)' }}>
          <Group justify="space-between" align="baseline" mb="sm">
            <Text fw={600} size="md">This quarter</Text>
            <Text size="sm" c="dimmed">
              {needsAction === 0 ? 'Nothing waiting on you.' : `${needsAction} client${needsAction === 1 ? '' : 's'} need${needsAction === 1 ? 's' : ''} something from you.`}
            </Text>
          </Group>
          <Group align="flex-start" gap="xl" wrap="wrap">
            {groups.map((g) => (
              <Box key={g.key} miw={160}>
                <Group gap={8} align="baseline" wrap="nowrap">
                  <Text size="xl" fw={600} lh={1} style={{ color: g.color }} data-num>
                    {g.clients.length}
                  </Text>
                  <Tooltip label={g.hint} multiline w={240}>
                    <Text size="sm" fw={500}>{g.label}</Text>
                  </Tooltip>
                </Group>
                {g.key !== 'done' && (
                  <Stack gap={2} mt={6}>
                    {g.clients.map((r) => (
                      <Anchor key={r.clientId} component={Link} to={`/clients/${r.clientId}`} size="sm">
                        {r.name}
                      </Anchor>
                    ))}
                  </Stack>
                )}
              </Box>
            ))}
          </Group>
        </Card>
      )}

      {loading ? (
        <Center h={160}>
          <Loader />
        </Center>
      ) : loadError ? (
        <Group gap="sm">
          <Text c="act.8" size="sm">Could not load the overview: {loadError}</Text>
          <Button size="compact-sm" variant="light" onClick={() => setRetry((n) => n + 1)}>Retry</Button>
        </Group>
      ) : rows.length === 0 ? (
        <Card padding="xl">
          <Center>
            <Stack align="center" gap="xs">
              <IconUsers size={28} stroke={1.5} color="var(--qbr-muted)" />
              <Text fw={600}>No QBR clients yet</Text>
              <Text size="sm" c="dimmed" ta="center" maw={420}>
                Import clients from Halo, then turn on the QBR toggle for the ones you review each quarter.
              </Text>
              <Button component={Link} to="/clients" variant="light" mt="xs">
                Go to Clients
              </Button>
            </Stack>
          </Center>
        </Card>
      ) : (
        <Table.ScrollContainer minWidth={1040}>
          <Table verticalSpacing="sm" style={{ background: 'var(--qbr-surface)', border: '1px solid var(--qbr-hairline)', borderRadius: 4 }}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Client</Table.Th>
                <Table.Th>This quarter</Table.Th>
                <Table.Th>Last review</Table.Th>
                <Table.Th>Maturity</Table.Th>
                <Table.Th>Health</Table.Th>
                <Table.Th ta="right">MRR</Table.Th>
                <Table.Th ta="right">Roadmap</Table.Th>
                <Table.Th>Spend, quarter over quarter</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {sorted.map((r) => {
                const urls = r.period ? reportUrls(r.clientId, r.period) : null;
                const t = triageOf(r.triage);
                return (
                  <Table.Tr
                    key={r.clientId}
                    className="triage-row"
                    style={{ cursor: 'pointer', ['--triage-color' as string]: t.color }}
                    onClick={() => navigate(`/clients/${r.clientId}`)}
                  >
                    <Table.Td>
                      <Anchor component={Link} to={`/clients/${r.clientId}`} fw={600} c="navy.9" onClick={(e) => e.stopPropagation()}>
                        {r.name}
                      </Anchor>
                      <Text size="xs" c="dimmed">
                        {[r.industry, r.hipaa ? 'HIPAA' : ''].filter(Boolean).join(', ')}
                      </Text>
                      {r.flags.length > 0 && (
                        <Stack gap={0} mt={4}>
                          {r.flags.map((f) => (
                            <Text key={f.label} size="xs" c={f.severity === 'red' ? 'act.8' : 'watch.8'}>
                              {f.label}
                            </Text>
                          ))}
                        </Stack>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <ThisQuarterCell r={r} />
                    </Table.Td>
                    <Table.Td>
                      {r.lastCompletedPeriod ? (
                        <Box>
                          <Anchor
                            component={Link}
                            to={`/clients/${r.clientId}?period=${r.lastCompletedPeriod}`}
                            size="sm"
                            fw={500}
                            data-num
                            onClick={(e) => e.stopPropagation()}
                          >
                            {r.lastCompletedPeriod}
                          </Anchor>
                          <Text size="xs" c="dimmed">Review complete</Text>
                        </Box>
                      ) : (
                        <Box>
                          <Text size="sm" c="dimmed">None completed</Text>
                          {r.period && r.period !== r.currentPeriod && (
                            <Text size="xs" c="dimmed" data-num>{r.period} {qbrStatusLabel(r.status).toLowerCase()}</Text>
                          )}
                        </Box>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {r.period ? <RatingBadge rating={r.rating} score={r.score} confidence={r.confidence} /> : <Text size="sm" c="dimmed">—</Text>}
                    </Table.Td>
                    <Table.Td>{r.health ? <HealthCell health={r.health} /> : <Text size="sm" c="dimmed">—</Text>}</Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm" fw={500} data-num>{r.mrr !== null ? money(r.mrr) : '—'}</Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      {r.roadmapValue > 0 ? (
                        <Box>
                          <Text size="sm" fw={500} data-num>{compactMoney(r.roadmapValue)}</Text>
                          <Text size="xs" c="dimmed">{r.roadmapCount} open</Text>
                        </Box>
                      ) : (
                        <Text size="sm" c="dimmed">—</Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <SpendCell pct={r.spendDeltaPct} spend={r.spend} />
                    </Table.Td>
                    <Table.Td ta="right" onClick={(e) => e.stopPropagation()}>
                      {urls && (
                        <Group gap={4} justify="flex-end" wrap="nowrap">
                          <Tooltip label="Open the last report">
                            <ActionIcon component="a" href={urls.html} target="_blank" variant="subtle" color="slate" aria-label={`Report for ${r.name}`}>
                              <IconFileText size={17} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label="Download the last PDF">
                            <ActionIcon component="a" href={urls.pdf} target="_blank" variant="subtle" color="slate" aria-label={`PDF for ${r.name}`}>
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
    </Stack>
  );
}
