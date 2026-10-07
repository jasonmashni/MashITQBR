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
  Tooltip,
} from '@mantine/core';
import { RadarChart, BarChart, DonutChart } from '@mantine/charts';
import { IconAlertTriangle, IconPencil, IconPaperclip, IconInfoCircle } from '@tabler/icons-react';
import { api, documentUrl } from '../../api.js';
import { money } from '../../format.js';
import type { DocumentInfo, QbrResponse, ReportConfig } from '../../types.js';
import { RatingBadge, ratingColorKey, ratingWord } from '../../ui.js';
import type { ReportModel } from '../../types.js';
import { NarrativeEditor } from './NarrativeEditor.js';
import { lockNotice } from './nextStep.js';

/** Human names for the NIST CSF 2.0 functions; the enum never reaches the screen. */
const FUNCTION_NAME: Record<string, string> = {
  GOVERN: 'Govern',
  IDENTIFY: 'Identify',
  PROTECT: 'Protect',
  DETECT: 'Detect',
  RESPOND: 'Respond',
  RECOVER: 'Recover',
};

const SINCE_LABEL: Record<string, { label: string; color: string }> = {
  done: { label: 'Done', color: 'good.8' },
  in_progress: { label: 'In progress', color: 'navy.8' },
  waiting: { label: 'Waiting', color: 'watch.8' },
  closed: { label: 'Closed', color: 'slate.6' },
};

const PLAN_COLUMNS = [
  { key: 'now', title: 'Now', span: 'next 30 days' },
  { key: 'next', title: 'Next', span: '31 to 60 days' },
  { key: 'later', title: 'Later', span: '61 to 90 days' },
] as const;

/** Page one as the client reads it: headline, opening, what we did, saw and need, since last quarter. */
function PageOnePreview({ model }: { model: ReportModel }) {
  const did = model.executive.did ?? model.executive.highlights;
  const saw = model.executive.saw ?? [];
  const decisions = model.decisions ?? [];
  const since = model.sinceLastQuarter ?? [];
  const lede = model.executive.lede ?? model.executive.paragraphs.join(' ');
  return (
    <>
      {model.executive.headline && <Text fw={600} c="navy.9" size="lg" mt={6} maw="40ch">{model.executive.headline}</Text>}
      {lede && <Text mt="sm" size="sm" maw="68ch">{lede}</Text>}
      <SimpleGrid cols={{ base: 1, md: 3 }} mt="md">
        <div>
          <Text size="sm" fw={600} c="brand.8" mb={4}>What we did</Text>
          {did.length ? <List size="sm" spacing={4}>{did.map((h, i) => <List.Item key={i}>{h}</List.Item>)}</List> : <Text size="sm" c="dimmed">Nothing yet.</Text>}
        </div>
        <div>
          <Text size="sm" fw={600} c="brand.8" mb={4}>What we saw</Text>
          {saw.length ? <List size="sm" spacing={4}>{saw.map((h, i) => <List.Item key={i}>{h}</List.Item>)}</List> : <Text size="sm" c="dimmed">Nothing yet.</Text>}
        </div>
        <Box p="sm" style={{ background: 'var(--mantine-color-watch-0)', borderTop: '2px solid var(--mantine-color-watch-7)', borderRadius: 4 }}>
          <Text size="sm" fw={600} c="watch.8" mb={4}>What we need from you</Text>
          {decisions.length ? (
            <Stack gap={6}>
              {decisions.map((d, i) => (
                <div key={i}>
                  <Text size="sm">{d.ask}</Text>
                  {(d.by || d.why) && <Text size="xs" c="dimmed">{[d.by, d.why].filter(Boolean).join('. ')}</Text>}
                </div>
              ))}
            </Stack>
          ) : (
            <Text size="sm" c="dimmed">Nothing needs a decision this quarter.</Text>
          )}
        </Box>
      </SimpleGrid>
      {since.length > 0 && (
        <Box mt="md" p="sm" style={{ background: 'var(--mantine-color-gray-0)', borderLeft: '4px solid var(--mantine-color-brand-8)' }}>
          <Text size="sm" fw={600} mb={4}>Since last quarter</Text>
          <Stack gap={4}>
            {since.map((r, i) => (
              <Group key={i} justify="space-between" wrap="nowrap">
                <Text size="sm">{r.topic}</Text>
                <Text size="sm" fw={600} c={SINCE_LABEL[r.status]?.color}>{SINCE_LABEL[r.status]?.label ?? r.status}</Text>
              </Group>
            ))}
          </Stack>
        </Box>
      )}
    </>
  );
}

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
  // A data-locked quarter keeps its frozen narrative: no edits, no regenerate.
  const lockedReason = lockNotice(qbr.meta);
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
          <Title order={4}>Page one, {model.period.label}</Title>
          <Tooltip label={lockedReason} disabled={!lockedReason} multiline w={300}>
            <Button size="xs" variant="light" leftSection={<IconPencil size={14} />} disabled={Boolean(lockedReason)} onClick={() => setEditing((e) => !e)}>
              {editing && !lockedReason ? 'Close the editor' : 'Edit the narrative'}
            </Button>
          </Tooltip>
        </Group>
        <PageOnePreview model={model} />
      </Card>

      {editing && !lockedReason && (
        <NarrativeEditor
          lockedReason={lockedReason}
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

      {(model.protection?.length ?? 0) > 0 && (
        <Card padding="lg">
          <Title order={5} mb={2}>How we are protecting you</Title>
          <Text size="xs" c="dimmed" mb="md">The five questions on page two, with the status and NIST scores the client sees.</Text>
          <Stack gap="sm">
            {model.protection!.map((row) => (
              <Group key={row.id} align="flex-start" wrap="nowrap" gap="md">
                <Box w={220} style={{ flex: '0 0 auto' }}>
                  <Text size="sm" fw={600}>{row.question}</Text>
                  <Text size="xs" c="dimmed">
                    {row.functions.map((f) => `${FUNCTION_NAME[f.function] ?? f.function} ${f.score === null ? 'not measured' : Math.round(f.score)}`).join(', ')}
                  </Text>
                </Box>
                <Box style={{ flex: 1 }}>
                  <Text size="sm">{row.inPlace || row.safeguards.filter((g) => g.measured).map((g) => g.evidence).join(' ') || 'Not measured this quarter.'}</Text>
                  {row.thisQuarter && <Text size="sm" c="dimmed" mt={2}>{row.thisQuarter}</Text>}
                </Box>
                <Badge color={ratingColorKey(row.rating)} variant="filled" style={{ flex: '0 0 auto' }}>{ratingWord(row.rating)}</Badge>
              </Group>
            ))}
          </Stack>
        </Card>
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

      {model.plan && model.plan.now.length + model.plan.next.length + model.plan.later.length > 0 ? (
        <Card padding="lg">
          <Title order={5} mb="md">The next 90 days</Title>
          <SimpleGrid cols={{ base: 1, md: 3 }}>
            {PLAN_COLUMNS.map((c) => (
              <div key={c.key}>
                <Text size="sm" fw={600} c="brand.8">{c.title} <Text span size="xs" c="dimmed" fw={400}>{c.span}</Text></Text>
                <Stack gap={6} mt={6}>
                  {model.plan![c.key].map((p, i) => (
                    <div key={i}>
                      <Text size="sm" fw={600}>{p.action}</Text>
                      <Text size="xs" c="dimmed">{p.owner}</Text>
                      {p.decision && <Text size="xs" fw={600} c="watch.8">Your decision</Text>}
                    </div>
                  ))}
                  {model.plan![c.key].length === 0 && <Text size="xs" c="dimmed">Nothing planned yet.</Text>}
                </Stack>
              </div>
            ))}
          </SimpleGrid>
        </Card>
      ) : (
        model.recommendations.length > 0 && (
          <Card padding="lg">
            <Title order={5} mb="md">Recommendations and the next 90 days</Title>
            <List size="sm" spacing={4}>{model.recommendations.map((r, i) => <List.Item key={i}>{r}</List.Item>)}</List>
          </Card>
        )
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
