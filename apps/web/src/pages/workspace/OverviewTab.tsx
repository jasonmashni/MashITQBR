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
  Box,
} from '@mantine/core';
import { RadarChart, BarChart, DonutChart } from '@mantine/charts';
import { IconAlertTriangle, IconPencil, IconPaperclip, IconInfoCircle } from '@tabler/icons-react';
import { api, documentUrl } from '../../api.js';
import { money } from '../../format.js';
import type { DocumentInfo, QbrResponse, ReportConfig } from '../../types.js';
import { RatingBadge, ratingColorKey, ratingWord } from '../../ui.js';
import { NarrativeEditor } from './NarrativeEditor.js';

/** Human names for the NIST CSF 2.0 functions; the enum never reaches the screen. */
const FUNCTION_NAME: Record<string, string> = {
  GOVERN: 'Govern',
  IDENTIFY: 'Identify',
  PROTECT: 'Protect',
  DETECT: 'Detect',
  RESPOND: 'Respond',
  RECOVER: 'Recover',
};

/** One brand-tinted ramp for the spend donut, largest slice first. */
const SPEND_PALETTE = ['#004aad', '#2866e7', '#0b2545', '#34539c', '#6b7a90', '#98a5b8', '#d8dfe8'];

/**
 * What the client will see, editable in place. Every visual is honest about
 * missing data: a withheld score says "Not scored", the radar is always on a
 * 0 to 100 axis, and a metric with no prior quarter draws one bar, not a
 * zero-height ghost.
 */
export function OverviewTab({
  qbr,
  clientId,
  period,
  refresh,
  aiEnabled,
  config,
  configError,
  setConfig,
  onChanged,
}: {
  qbr: QbrResponse;
  clientId: string;
  period: string;
  refresh: number;
  aiEnabled: boolean;
  config: ReportConfig | null;
  configError: string | null;
  setConfig: (c: ReportConfig) => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [docs, setDocs] = useState<DocumentInfo[]>([]);
  const { model } = qbr;
  const overall = model.scorecard.overall;
  const scored = overall.score !== null && overall.confidence !== 'low';
  const coveragePct = Math.round((overall.coverage ?? 0) * 100);
  const measuredFns = useMemo(() => model.scorecard.functions.filter((f) => f.score !== null), [model.scorecard.functions]);
  const unmeasuredFns = useMemo(() => model.scorecard.functions.filter((f) => f.score === null), [model.scorecard.functions]);
  const radar = useMemo(() => measuredFns.map((f) => ({ function: FUNCTION_NAME[f.function] ?? f.function, score: Math.round(f.score ?? 0) })), [measuredFns]);
  const ringSections = useMemo(
    () => [{ value: scored ? (overall.score as number) : 0, color: `${ratingColorKey(overall.rating)}.8` }],
    [scored, overall.score, overall.rating],
  );

  // Service-desk and security counts only; telemetry volumes and automated
  // alerts dwarf everything else on a shared axis.
  const trendRows = useMemo(
    () =>
      model.trends
        .filter(
          (t) =>
            t.current !== null &&
            (t.category === 'operations' || t.category === 'security') &&
            !/siem|logs|events|signals|alert/i.test(t.key),
        )
        .slice(0, 6),
    [model.trends],
  );
  const trendData = useMemo(
    () => trendRows.map((t) => ({ label: t.label, previous: t.previous, current: t.current ?? 0 })),
    [trendRows],
  );
  const noPrior = useMemo(() => trendRows.filter((t) => t.previous === null).map((t) => t.label), [trendRows]);

  // High-level spend picture: quarterly invoiced categories only, so monthly
  // recurring amounts never share an axis with quarterly totals.
  const spendData = useMemo(() => {
    const invoiced = model.trends.filter((t) => t.current !== null && t.key.startsWith('finance.invoiced.'));
    const rows = invoiced.length > 0 ? invoiced : model.trends.filter((t) => t.current !== null && t.key.startsWith('finance.recurring.'));
    return rows
      .map((t) => ({ label: t.label.replace(/\s+/g, ' '), amount: t.current ?? 0 }))
      .filter((r) => r.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 7);
  }, [model.trends]);
  const spendIsRecurring = useMemo(() => !model.trends.some((t) => t.key.startsWith('finance.invoiced.')), [model.trends]);
  const spendDonut = useMemo(() => {
    const total = spendData.reduce((s, r) => s + r.amount, 0);
    return {
      total,
      slices: spendData.map((r, i) => ({
        name: r.label,
        value: r.amount,
        color: SPEND_PALETTE[i] ?? SPEND_PALETTE[SPEND_PALETTE.length - 1]!,
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

  const dataConfidence = model.dataConfidence ?? [];

  return (
    <Stack gap="lg">
      {dataConfidence.length > 0 && (
        <Alert color="watch" variant="light" icon={<IconAlertTriangle size={18} />} title="Data confidence">
          <Text size="xs" c="dimmed" mb={4}>These caveats print on the report so a sampled count is never read as a complete one.</Text>
          <List size="sm" spacing={2}>{dataConfidence.map((w, i) => <List.Item key={i}>{w}</List.Item>)}</List>
        </Alert>
      )}
      {qbr.warnings.length > 0 && (
        <Alert color="slate" variant="light" icon={<IconInfoCircle size={18} />} title="Report notes">
          <List size="sm" spacing={2}>{qbr.warnings.map((w, i) => <List.Item key={i}>{w}</List.Item>)}</List>
        </Alert>
      )}

      <Card padding="lg">
        <Group justify="space-between" align="flex-start">
          <Title order={4}>Executive summary, {model.period.label}</Title>
          <Button size="xs" variant="light" leftSection={<IconPencil size={14} />} onClick={() => setEditing((e) => !e)}>
            {editing ? 'Close the editor' : 'Edit the narrative'}
          </Button>
        </Group>
        {model.executive.headline && <Text fw={600} c="navy.9" size="lg" mt={6} maw="40ch">{model.executive.headline}</Text>}
        <Box maw="68ch">
          {model.executive.paragraphs.map((p, i) => <Text key={i} mt="sm" size="sm">{p}</Text>)}
          {model.executive.highlights.length > 0 && (
            <List size="sm" mt="md" spacing={4}>{model.executive.highlights.map((h, i) => <List.Item key={i}>{h}</List.Item>)}</List>
          )}
        </Box>
      </Card>

      {editing && (
        <NarrativeEditor
          clientId={clientId}
          period={period}
          model={model}
          aiEnabled={aiEnabled}
          status={qbr.meta.status}
          verified={qbr.verification}
          config={config}
          configError={configError}
          setConfig={setConfig}
          onChanged={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Card padding="lg">
          <Title order={5} mb="md">Security maturity</Title>
          {scored ? (
            <Group align="center">
              <RingProgress
                size={150}
                thickness={14}
                roundCaps
                sections={ringSections}
                label={
                  <Center>
                    <Stack gap={0} align="center">
                      <Text fw={600} size="xl" data-num>{Math.round(overall.score as number)}</Text>
                      <Text size="xs" c="dimmed">out of 100</Text>
                    </Stack>
                  </Center>
                }
              />
              <Stack gap={4}>
                <RatingBadge rating={overall.rating} score={overall.score} confidence={overall.confidence} />
                <Text size="sm" c="dimmed">Based on {coveragePct}% of the controls we check.</Text>
                {overall.confidence === 'medium' && <Text size="xs" c="watch.8" maw={200}>Provisional: the score firms up as more tools are connected.</Text>}
                <Text size="xs" c="dimmed" maw={200}>Blended CIS Controls v8 under NIST CSF 2.0.</Text>
              </Stack>
            </Group>
          ) : (
            <Stack gap={4}>
              <Text fw={600} size="lg" c="slate.7">Not scored</Text>
              <Text size="sm" maw="48ch">
                Not enough security data to score this quarter. Only {coveragePct}% of the controls we check could be measured; the report says the same.
              </Text>
              <Text size="xs" c="dimmed" maw="48ch">Connect the remaining tools on the Integrations page and the score appears next sync. Nothing here is a failing grade.</Text>
            </Stack>
          )}
        </Card>

        <Card padding="lg">
          <Title order={5} mb="md">Maturity by function</Title>
          {measuredFns.length >= 3 ? (
            <RadarChart
              h={230}
              data={radar}
              dataKey="function"
              withPolarRadiusAxis
              polarRadiusAxisProps={{ domain: [0, 100], tickCount: 5 }}
              series={[{ name: 'score', color: 'brand.6', opacity: 0.3 }]}
            />
          ) : measuredFns.length > 0 ? (
            <Stack gap="sm">
              {measuredFns.map((f) => (
                <div key={f.function}>
                  <Group justify="space-between" mb={2}>
                    <Text size="sm" fw={600}>{FUNCTION_NAME[f.function] ?? f.function}</Text>
                    <Text size="sm" c="dimmed" data-num>{Math.round(f.score ?? 0)} {ratingWord(f.rating)}</Text>
                  </Group>
                  <Progress value={f.score ?? 0} color={`${ratingColorKey(f.rating)}.8`} size="md" radius="xs" />
                </div>
              ))}
            </Stack>
          ) : (
            <Text size="sm" c="dimmed">No function could be measured yet. Sync with mapped security tools to light these up.</Text>
          )}
          {measuredFns.length > 0 && unmeasuredFns.length > 0 && (
            <Text size="xs" c="dimmed" mt="sm">
              Not measured this quarter: {unmeasuredFns.map((f) => FUNCTION_NAME[f.function] ?? f.function).join(', ')}.
            </Text>
          )}
        </Card>
      </SimpleGrid>

      {trendData.length > 0 && (
        <Card padding="lg">
          <Title order={5} mb={2}>Quarter over quarter</Title>
          <Text size="xs" c="dimmed" mb="md">Service-desk and security counts only; automated alerts and telemetry volumes are excluded.</Text>
          <BarChart
            h={280}
            data={trendData}
            dataKey="label"
            xAxisProps={{ interval: 0, angle: -18, textAnchor: 'end', height: 64 }}
            series={[
              { name: 'previous', label: model.previousPeriod?.label ?? 'Previous quarter', color: 'slate.4' },
              { name: 'current', label: model.period.label, color: 'brand.8' },
            ]}
          />
          {noPrior.length > 0 && (
            <Text size="xs" c="dimmed" mt={4}>No prior quarter for: {noPrior.join(', ')}.</Text>
          )}
        </Card>
      )}

      {spendData.length > 0 && (
        <Card padding="lg">
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
              valueFormatter={(v) => money(Math.round(v))}
              chartLabel={money(Math.round(spendDonut.total))}
            />
            <Stack gap={8} style={{ flex: 1, minWidth: 240 }}>
              {spendDonut.slices.map((s) => (
                <Group key={s.name} justify="space-between" wrap="nowrap" gap="sm">
                  <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, flex: '0 0 auto' }} />
                    <Text size="sm" truncate>{s.name}</Text>
                  </Group>
                  <Group gap={10} wrap="nowrap" style={{ flex: '0 0 auto' }}>
                    <Text size="sm" fw={600} data-num>{money(Math.round(s.value))}</Text>
                    <Text size="xs" c="dimmed" w={34} ta="right" data-num>{s.pct}%</Text>
                  </Group>
                </Group>
              ))}
              <Divider my={2} />
              <Group justify="space-between">
                <Text size="sm" c="dimmed">Total {spendIsRecurring ? 'monthly' : 'invoiced'}</Text>
                <Text size="sm" fw={600} data-num>{money(Math.round(spendDonut.total))}</Text>
              </Group>
            </Stack>
          </Group>
        </Card>
      )}

      {model.recommendations.length > 0 && (
        <Card padding="lg">
          <Title order={5} mb="md">Recommendations and the next 90 days</Title>
          <List size="sm" spacing={4}>{model.recommendations.map((r, i) => <List.Item key={i}>{r}</List.Item>)}</List>
        </Card>
      )}

      {docs.length > 0 && (
        <Card padding="lg">
          <Title order={5} mb="sm">Attached reports</Title>
          <Group gap="xs">
            {docs.map((d) => (
              <Badge
                key={d.id}
                component="a"
                href={documentUrl(clientId, period, d.id)}
                color="navy"
                leftSection={<IconPaperclip size={12} />}
                style={{ cursor: 'pointer', height: 'auto' }}
              >
                {d.name}
              </Badge>
            ))}
          </Group>
          <Text size="xs" c="dimmed" mt={6}>These appear in the report appendix. Manage them on the Reports tab.</Text>
        </Card>
      )}
    </Stack>
  );
}
