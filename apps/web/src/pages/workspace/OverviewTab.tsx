import { useEffect, useMemo, useState } from 'react';
import {
  Title,
  Group,
  Button,
  Card,
  Text,
  Stack,
  SimpleGrid,
  RingProgress,
  Alert,
  List,
  Center,
  Badge,
  Divider,
  Progress,
} from '@mantine/core';
import { RadarChart, BarChart, DonutChart } from '@mantine/charts';
import { IconAlertTriangle, IconPencil, IconPaperclip } from '@tabler/icons-react';
import { api, documentUrl } from '../../api.js';
import type { DocumentInfo, QbrResponse, ReportConfig } from '../../types.js';
import { RatingBadge } from '../../ui.js';
import { NarrativeEditor } from './NarrativeEditor.js';

const RING_COLOR: Record<string, string> = { green: 'teal', amber: 'yellow', red: 'red', unknown: 'gray' };

// ── Overview tab: what the client will see, editable in place ────────────────
export function OverviewTab({
  qbr,
  clientId,
  period,
  refresh,
  aiEnabled,
  config,
  setConfig,
  onChanged,
}: {
  qbr: QbrResponse;
  clientId: string;
  period: string;
  refresh: number;
  aiEnabled: boolean;
  config: ReportConfig | null;
  setConfig: (c: ReportConfig) => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [docs, setDocs] = useState<DocumentInfo[]>([]);
  const { model } = qbr;
  const score = model.scorecard.overall.score ?? 0;
  // Unmeasured functions (score null) must not render as 0 — with sparse data
  // a radar collapses into misleading spikes, so fall back to bars.
  const measuredFns = useMemo(() => model.scorecard.functions.filter((f) => f.score !== null), [model.scorecard.functions]);
  const unmeasuredFns = useMemo(() => model.scorecard.functions.filter((f) => f.score === null), [model.scorecard.functions]);
  const radar = useMemo(() => measuredFns.map((f) => ({ function: f.function, score: f.score ?? 0 })), [measuredFns]);
  const ringSections = useMemo(
    () => [{ value: score, color: RING_COLOR[model.scorecard.overall.rating] ?? 'gray' }],
    [score, model.scorecard.overall.rating],
  );
  const trendData = useMemo(
    () =>
      model.trends
        // Automated alerts (and raw telemetry) dwarf the service-desk figures on
        // a shared axis — the QoQ chart is about the human-facing ticket work.
        .filter(
          (t) =>
            t.current !== null &&
            (t.category === 'operations' || t.category === 'security') &&
            !/siem|logs|events|signals|alert/i.test(t.key),
        )
        .slice(0, 6)
        .map((t) => ({
          label: t.label.length > 14 ? t.label.slice(0, 13) + '…' : t.label,
          previous: t.previous ?? 0,
          current: t.current ?? 0,
        })),
    [model.trends],
  );
  // High-level spend picture for the client-facing overview. Quarterly
  // invoiced categories only — mixing monthly recurring amounts onto the same
  // axis would compare different measures.
  const spendData = useMemo(() => {
    const invoiced = model.trends.filter((t) => t.current !== null && t.key.startsWith('finance.invoiced.'));
    const rows = invoiced.length > 0 ? invoiced : model.trends.filter((t) => t.current !== null && t.key.startsWith('finance.recurring.'));
    return rows
      .map((t) => ({
        label: (t.label.length > 24 ? t.label.slice(0, 23) + '…' : t.label).replace(/\s+/g, ' '),
        amount: t.current ?? 0,
      }))
      .filter((r) => r.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 7);
  }, [model.trends]);
  const spendIsRecurring = useMemo(() => !model.trends.some((t) => t.key.startsWith('finance.invoiced.')), [model.trends]);
  // A brand-tinted, single-system palette (navy → blue → teal → slate → light),
  // assigned largest-slice-first so the donut reads as one elegant ramp rather
  // than a rainbow. Total sits in the middle; the legend carries exact $ and %.
  const spendDonut = useMemo(() => {
    const palette = ['#004aad', '#2f7bff', '#0b7285', '#3b5b78', '#5f7d99', '#8fa6bd', '#b9c4cf'];
    const total = spendData.reduce((s, r) => s + r.amount, 0);
    return {
      total,
      slices: spendData.map((r, i) => ({
        name: r.label,
        value: r.amount,
        color: palette[i] ?? '#b9c4cf',
        pct: total > 0 ? Math.round((r.amount / total) * 100) : 0,
      })),
    };
  }, [spendData]);

  useEffect(() => {
    let live = true;
    api.listDocuments(clientId, period).then((d) => live && setDocs(d.documents)).catch(() => {});
    return () => {
      live = false;
    };
  }, [clientId, period, refresh]);

  return (
    <Stack gap="lg">
      {qbr.warnings.length > 0 && (
        <Alert color="yellow" icon={<IconAlertTriangle size={18} />} title="Data notes">
          <List size="sm" spacing={2}>{qbr.warnings.map((w, i) => <List.Item key={i}>{w}</List.Item>)}</List>
        </Alert>
      )}

      <Card withBorder radius="md" padding="lg">
        <Group justify="space-between" align="flex-start">
          <Title order={4}>{model.period.label} — Executive summary</Title>
          <Button size="xs" variant="light" leftSection={<IconPencil size={14} />} onClick={() => setEditing((e) => !e)}>
            {editing ? 'Close editor' : 'Edit narrative'}
          </Button>
        </Group>
        {model.executive.headline && <Text fw={600} c="navy.9" mt={4}>{model.executive.headline}</Text>}
        {model.executive.paragraphs.map((p, i) => <Text key={i} mt="sm" size="sm">{p}</Text>)}
        {model.executive.highlights.length > 0 && (
          <List size="sm" mt="md" spacing={4}>{model.executive.highlights.map((h, i) => <List.Item key={i}>{h}</List.Item>)}</List>
        )}
      </Card>

      {editing && (
        <NarrativeEditor
          clientId={clientId}
          period={period}
          model={model}
          aiEnabled={aiEnabled}
          status={qbr.meta.status}
          config={config}
          setConfig={setConfig}
          onChanged={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Card withBorder radius="md" padding="lg">
          <Title order={5} mb="md">Security maturity</Title>
          <Group>
            <RingProgress
              size={150}
              thickness={14}
              roundCaps
              sections={ringSections}
              label={<Center><Stack gap={0} align="center"><Text fw={700} size="xl">{model.scorecard.overall.score ?? '—'}</Text><Text size="xs" c="dimmed">/ 100</Text></Stack></Center>}
            />
            <Stack gap={4}>
              <RatingBadge rating={model.scorecard.overall.rating} />
              <Text size="sm" c="dimmed">Coverage {Math.round((model.scorecard.overall.coverage ?? 0) * 100)}%</Text>
              <Text size="xs" c="dimmed" maw={180}>Blended CIS Controls v8 under NIST CSF 2.0.</Text>
            </Stack>
          </Group>
        </Card>

        <Card withBorder radius="md" padding="lg">
          <Title order={5} mb="md">Maturity by function</Title>
          {measuredFns.length >= 3 ? (
            <RadarChart h={230} data={radar} dataKey="function" withPolarRadiusAxis series={[{ name: 'score', color: 'teal.7', opacity: 0.35 }]} />
          ) : measuredFns.length > 0 ? (
            <Stack gap="sm">
              {measuredFns.map((f) => (
                <div key={f.function}>
                  <Group justify="space-between" mb={2}>
                    <Text size="sm" fw={600}>{f.function}</Text>
                    <Text size="sm" c="dimmed">{Math.round(f.score ?? 0)} / 100</Text>
                  </Group>
                  <Progress value={f.score ?? 0} color={RING_COLOR[f.rating] ?? 'teal'} size="md" radius="sm" />
                </div>
              ))}
            </Stack>
          ) : (
            <Text size="sm" c="dimmed">No function scores available yet — run a Sync with mapped tools.</Text>
          )}
          {measuredFns.length > 0 && unmeasuredFns.length > 0 && (
            <Text size="xs" c="dimmed" mt="sm">
              Not yet measured: {unmeasuredFns.map((f) => f.function).join(', ')} — connect more tools to light these up.
            </Text>
          )}
        </Card>
      </SimpleGrid>

      {trendData.length > 0 && (
        <Card withBorder radius="md" padding="lg">
          <Title order={5} mb="md">Quarter-over-quarter</Title>
          <BarChart
            h={260}
            data={trendData}
            dataKey="label"
            series={[
              { name: 'previous', label: 'Previous', color: 'gray.5' },
              { name: 'current', label: 'Current', color: 'navy.7' },
            ]}
          />
        </Card>
      )}

      {spendData.length > 0 && (
        <Card withBorder radius="md" padding="lg">
          <Title order={5} mb={2}>{spendIsRecurring ? 'Monthly recurring breakdown' : 'Where the IT investment went'}</Title>
          <Text size="xs" c="dimmed" mb="md">{spendIsRecurring ? 'Composition of the monthly bill.' : 'Invoiced this quarter, by category.'}</Text>
          <Group align="center" gap={40} wrap="wrap">
            <DonutChart
              data={spendDonut.slices}
              size={190}
              thickness={26}
              paddingAngle={2}
              withTooltip
              tooltipDataSource="segment"
              valueFormatter={(v) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
              chartLabel={`$${spendDonut.total.toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
            />
            <Stack gap={8} style={{ flex: 1, minWidth: 240 }}>
              {spendDonut.slices.map((s) => (
                <Group key={s.name} justify="space-between" wrap="nowrap" gap="sm">
                  <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flex: '0 0 auto' }} />
                    <Text size="sm" truncate>{s.name}</Text>
                  </Group>
                  <Group gap={10} wrap="nowrap" style={{ flex: '0 0 auto' }}>
                    <Text size="sm" fw={600}>${s.value.toLocaleString('en-US', { maximumFractionDigits: 0 })}</Text>
                    <Text size="xs" c="dimmed" w={34} ta="right">{s.pct}%</Text>
                  </Group>
                </Group>
              ))}
              <Divider my={2} />
              <Group justify="space-between">
                <Text size="sm" c="dimmed">Total {spendIsRecurring ? 'monthly' : 'invoiced'}</Text>
                <Text size="sm" fw={700}>${spendDonut.total.toLocaleString('en-US', { maximumFractionDigits: 0 })}</Text>
              </Group>
            </Stack>
          </Group>
        </Card>
      )}

      {model.recommendations.length > 0 && (
        <Card withBorder radius="md" padding="lg">
          <Title order={5} mb="md">Recommendations &amp; next 90 days</Title>
          <List size="sm" spacing={4}>{model.recommendations.map((r, i) => <List.Item key={i}>{r}</List.Item>)}</List>
        </Card>
      )}

      {docs.length > 0 && (
        <Card withBorder radius="md" padding="lg">
          <Title order={5} mb="sm">Attached reports</Title>
          <Group gap="xs">
            {docs.map((d) => (
              <Badge
                key={d.id}
                component="a"
                href={documentUrl(clientId, period, d.id)}
                variant="light"
                color="navy"
                leftSection={<IconPaperclip size={12} />}
                style={{ cursor: 'pointer', textTransform: 'none' }}
              >
                {d.name}
              </Badge>
            ))}
          </Group>
          <Text size="xs" c="dimmed" mt={6}>These appear in the report appendix. Manage them on the Data tab.</Text>
        </Card>
      )}
    </Stack>
  );
}
