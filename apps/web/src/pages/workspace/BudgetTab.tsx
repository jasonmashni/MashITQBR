import { useEffect, useState, type ReactNode } from 'react';
import { planningPeriodFor } from '@mashit/core';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Grid,
  Group,
  List,
  Loader,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { api, ApiError } from '../../api.js';
import type { BudgetAnswers, BudgetPlanRecord } from '../../types.js';
import { toastError, toastOk } from '../../toast.js';
import {
  BUDGET_STEPS,
  CATEGORY_LABEL,
  MONTHS,
  SOURCE_LABEL,
  linesToSentences,
  money,
  plannerYear,
  pvaTone,
  quarterLabel,
  reviewLabel,
  sentencesToLines,
  stepDone,
  type BudgetKnownFact,
  type BudgetPlanVsActual,
  type BudgetStep,
} from './budget.js';

// ── Budget planner: internal prep for next fiscal year's IT budget ────────────
// Left: what the connected tools already tell us. Middle: the six questions
// only the account manager or the client can answer. Right: AI industry
// context, internal only. Below: the outlook that becomes the client page and
// plan versus actual for the current fiscal year. No ticket text or PHI here.

const num = (v: string | number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A labelled question with the hint line from the approved mockup. */
function Question({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <Stack gap={4}>
      <div>
        <Text size="sm" fw={600}>{label}</Text>
        <Text size="xs" c="dimmed">{hint}</Text>
      </div>
      {children}
    </Stack>
  );
}

export function BudgetTab({ clientId, period, onPublished }: { clientId: string; period: string; onPublished?: () => void }) {
  const [loading, setLoading] = useState(true);
  const [startMonth, setStartMonth] = useState(1);
  const [known, setKnown] = useState<BudgetKnownFact[]>([]);
  const [fy, setFy] = useState<number | null>(null);
  const [plan, setPlan] = useState<BudgetPlanRecord | null>(null);
  const [actual, setActual] = useState<BudgetPlanVsActual | null>(null);
  const [answers, setAnswers] = useState<BudgetAnswers>({});
  const [assumptions, setAssumptions] = useState('');
  const [movers, setMovers] = useState('');
  const [step, setStep] = useState<BudgetStep>('People');
  const [busy, setBusy] = useState<'save' | 'outlook' | 'publish' | 'context' | null>(null);
  const [contextNote, setContextNote] = useState<string | null>(null);

  const year = plannerYear(period, startMonth);

  // Client fiscal settings and the known facts.
  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .listBudgets(clientId)
      .then((d) => {
        if (!live) return;
        setStartMonth(d.fiscalYearStartMonth);
        setKnown(d.known);
        setFy(plannerYear(period, d.fiscalYearStartMonth).label);
      })
      .catch((e) => toastError('Could not load the budget planner', e))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [clientId, period]);

  // The selected fiscal year's plan (404 means none yet).
  useEffect(() => {
    if (fy === null) return;
    let live = true;
    api
      .getBudget(clientId, fy)
      .then((d) => live && adopt(d.plan))
      .catch((e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) adopt(null);
        else toastError('Could not load the plan', e);
      });
    return () => {
      live = false;
    };
  }, [clientId, fy]);

  // Plan versus actual always reads the fiscal year the period belongs to.
  useEffect(() => {
    let live = true;
    api
      .getBudget(clientId, year.currentLabel)
      .then((d) => live && setActual(d.planVsActual ?? null))
      .catch(() => live && setActual(null));
    return () => {
      live = false;
    };
  }, [clientId, year.currentLabel, plan?.status]);

  function adopt(p: BudgetPlanRecord | null) {
    setPlan(p);
    setAnswers(p?.answers ?? {});
    setAssumptions(sentencesToLines(p?.assumptions ?? []));
    setMovers(sentencesToLines(p?.movers ?? []));
  }

  const set = (patch: Partial<BudgetAnswers>) => setAnswers((a) => ({ ...a, ...patch }));

  async function save(): Promise<boolean> {
    if (fy === null) return false;
    try {
      const r = await api.putBudget(clientId, fy, { answers, assumptions: linesToSentences(assumptions), movers: linesToSentences(movers) });
      adopt(r.plan);
      return true;
    } catch (e) {
      toastError('Could not save the answers', e);
      return false;
    }
  }

  async function run(kind: 'save' | 'outlook' | 'publish' | 'context') {
    if (fy === null) return;
    setBusy(kind);
    try {
      if (kind === 'save') {
        if (await save()) toastOk('Answers saved.');
      } else if (kind === 'outlook') {
        if (!(await save())) return;
        adopt((await api.recomputeBudget(clientId, fy)).plan);
        toastOk('Outlook updated.');
      } else if (kind === 'publish') {
        if (!(await save())) return;
        adopt((await api.publishBudget(clientId, fy)).plan);
        toastOk(`The FY${fy} outlook is on the ${quarterLabel(planningPeriodFor(fy, startMonth))} report.`);
        onPublished?.();
      } else {
        const r = await api.researchBudget(clientId, fy);
        if (!r.available) setContextNote(r.note ?? 'Industry context is unavailable.');
        else if (r.plan) {
          setContextNote(null);
          setPlan(r.plan);
        }
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toastError('Quarter is locked', new Error('The planning quarter is locked. Reopen it before putting the plan on its report.'));
      } else {
        toastError(kind === 'context' ? 'Research failed' : kind === 'publish' ? 'Could not put the plan on the report' : 'Could not update the outlook', e);
      }
    } finally {
      setBusy(null);
    }
  }

  if (loading || fy === null) return <Center h={160}><Loader /></Center>;

  const fyPlanningPeriod = planningPeriodFor(fy, startMonth);
  const publishLabel = `Put on the ${quarterLabel(fyPlanningPeriod)} report`;
  const fyOptions = [year.currentLabel, year.currentLabel + 1].map((l) => ({ value: String(l), label: `FY${l}` }));

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <div>
          <Group gap="sm" align="center">
            <Title order={3}>Budget planner, fiscal year {fy}</Title>
            <Select
              aria-label="Fiscal year"
              size="xs"
              w={110}
              data={fyOptions}
              value={String(fy)}
              onChange={(v) => v && setFy(Number(v))}
              allowDeselect={false}
            />
            {plan?.status === 'published' ? (
              <Badge color="good" variant="light">On the report</Badge>
            ) : (
              <Badge color="slate" variant="light">Draft</Badge>
            )}
          </Group>
          <Text size="sm" c="dimmed">
            Fiscal year starts {MONTHS[startMonth - 1]}. Planning quarter: {reviewLabel(fyPlanningPeriod)}.
            {plan ? ` Last saved by ${plan.updatedBy}, ${new Date(plan.updatedAt).toLocaleDateString()}.` : ' Not saved yet.'}
          </Text>
        </div>
        <Group gap="xs">
          <Button variant="default" loading={busy === 'outlook'} disabled={busy !== null} onClick={() => run('outlook')}>Re-run outlook</Button>
          <Button loading={busy === 'publish'} disabled={busy !== null || !plan?.lines.length} onClick={() => run('publish')}>{publishLabel}</Button>
        </Group>
      </Group>

      {year.planning ? (
        <Alert color="brand" title="Planning quarter">
          This review is where we plan the FY{year.label} budget with the client. Fill in the answers, re-run the outlook, then put it on the report.
        </Alert>
      ) : (
        <Text size="sm" c="dimmed">Next year's budget is planned at the {year.nextPlanningReview}.</Text>
      )}

      <Grid gutter="md">
        <Grid.Col span={{ base: 12, md: 6, lg: 4 }}>
          <Card withBorder padding="md" h="100%">
            <Group justify="space-between" mb="xs">
              <Text fw={700}>What we already know</Text>
              <Badge color="good" variant="light">From connected tools</Badge>
            </Group>
            {known.length ? (
              <List size="sm" spacing={6}>
                {known.map((k) => (
                  <List.Item key={k.text}>
                    {k.text} <Text span size="xs" c="dimmed">{k.source}</Text>
                  </List.Item>
                ))}
              </List>
            ) : (
              <Text size="sm" c="dimmed">No synced data yet. Sync a quarter to fill this in.</Text>
            )}
          </Card>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 6, lg: 5 }}>
          <Card withBorder padding="md" h="100%">
            <Text fw={700} mb="xs">What only you can tell us</Text>
            <Group gap={6} mb="md">
              {BUDGET_STEPS.map((s) => (
                <UnstyledButton key={s} onClick={() => setStep(s)} aria-pressed={s === step}>
                  <Badge variant={s === step ? 'filled' : 'light'} color={s === step ? 'brand' : stepDone(s, answers) ? 'good' : 'slate'} style={{ cursor: 'pointer', textTransform: 'none' }}>
                    {s}
                  </Badge>
                </UnstyledButton>
              ))}
            </Group>

            <Stack gap="md">
              {step === 'People' && (
                <>
                  <Question label="Headcount change expected" hint="New hires minus planned leavers over the next twelve months.">
                    <NumberInput value={answers.headcountChange ?? ''} onChange={(v) => set({ headcountChange: num(v) })} allowDecimal={false} placeholder="e.g. 2" maw={200} />
                  </Question>
                  <Question label="Copilot seats to plan for" hint="Leave blank if Copilot is not on the table. Priced per seat per month.">
                    <Group gap="xs">
                      <NumberInput aria-label="Copilot seats" value={answers.copilotSeats ?? ''} onChange={(v) => set({ copilotSeats: num(v) })} allowDecimal={false} min={0} placeholder="Seats" maw={120} />
                      <NumberInput aria-label="Copilot price per seat" value={answers.copilotSeatPrice ?? ''} onChange={(v) => set({ copilotSeatPrice: num(v) })} min={0} prefix="$" placeholder="Price" maw={120} />
                    </Group>
                  </Question>
                </>
              )}
              {step === 'Places' && (
                <Question label="Any new locations or lines in the next twelve months?" hint="A new site typically adds a firewall, switching, Wi-Fi and monitoring.">
                  <SegmentedControl
                    value={answers.newLocations === undefined ? '' : String(answers.newLocations)}
                    onChange={(v) => set({ newLocations: Number(v) as 0 | 1 | 2 })}
                    data={[
                      { value: '0', label: 'No' },
                      { value: '1', label: 'One' },
                      { value: '2', label: 'More than one' },
                    ]}
                  />
                </Question>
              )}
              {step === 'Projects' && (
                <Question label="Projects to budget for" hint="Opportunity board items with a one-time value are included automatically. Add anything else here with a low and high estimate.">
                  <Stack gap="xs">
                    {(answers.projects ?? []).map((p, i) => (
                      <Group key={i} gap="xs" wrap="nowrap">
                        <TextInput aria-label="Project" placeholder="Project" value={p.name} onChange={(e) => set({ projects: (answers.projects ?? []).map((x, j) => (j === i ? { ...x, name: e.currentTarget.value } : x)) })} style={{ flex: 1 }} />
                        <NumberInput aria-label="Low estimate" placeholder="Low" prefix="$" min={0} value={p.low ?? ''} onChange={(v) => set({ projects: (answers.projects ?? []).map((x, j) => (j === i ? { ...x, low: num(v) } : x)) })} w={110} />
                        <NumberInput aria-label="High estimate" placeholder="High" prefix="$" min={0} value={p.high ?? ''} onChange={(v) => set({ projects: (answers.projects ?? []).map((x, j) => (j === i ? { ...x, high: num(v) } : x)) })} w={110} />
                        <ActionIcon variant="subtle" color="slate" aria-label="Remove project" onClick={() => set({ projects: (answers.projects ?? []).filter((_, j) => j !== i) })}><IconTrash size={16} /></ActionIcon>
                      </Group>
                    ))}
                    <Button variant="light" size="xs" leftSection={<IconPlus size={14} />} w="fit-content" onClick={() => set({ projects: [...(answers.projects ?? []), { name: '' }] })}>Add project</Button>
                  </Stack>
                </Question>
              )}
              {step === 'Lifecycle' && (
                <>
                  <Question label="Standard workstation cost to plan with" hint="Used for every refresh estimate and for the warranty line on the report.">
                    <NumberInput value={answers.workstationUnitCost ?? ''} onChange={(v) => set({ workstationUnitCost: num(v) })} prefix="$" min={0} placeholder="e.g. 1650" maw={200} />
                  </Question>
                  <Question label="Risk appetite for hardware" hint="Whether aging devices are refreshed at warranty end, early, or run to failure.">
                    <SegmentedControl
                      value={answers.refreshPolicy ?? ''}
                      onChange={(v) => set({ refreshPolicy: v as BudgetAnswers['refreshPolicy'] })}
                      data={[
                        { value: 'run_to_failure', label: 'Run to failure' },
                        { value: 'at_warranty_end', label: 'Refresh at warranty end' },
                        { value: 'early', label: 'Refresh early' },
                      ]}
                    />
                  </Question>
                </>
              )}
              {step === 'Compliance' && (
                <Question label="Compliance deadlines in the year" hint="Assessments, audits or renewals with a date, and an estimate when you have one.">
                  <Stack gap="xs">
                    {(answers.complianceDeadlines ?? []).map((d, i) => {
                      const update = (patch: Partial<typeof d>) => set({ complianceDeadlines: (answers.complianceDeadlines ?? []).map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                      return (
                        <Group key={i} gap="xs" wrap="nowrap">
                          <TextInput aria-label="What" placeholder="What" value={d.what} onChange={(e) => update({ what: e.currentTarget.value })} style={{ flex: 1 }} />
                          <TextInput aria-label="When" placeholder="When" value={d.when} onChange={(e) => update({ when: e.currentTarget.value })} w={100} />
                          <NumberInput aria-label="Estimate" placeholder="Estimate" prefix="$" min={0} value={d.estimate ?? ''} onChange={(v) => update({ estimate: num(v) })} w={110} />
                          <ActionIcon variant="subtle" color="slate" aria-label="Remove deadline" onClick={() => set({ complianceDeadlines: (answers.complianceDeadlines ?? []).filter((_, j) => j !== i) })}><IconTrash size={16} /></ActionIcon>
                        </Group>
                      );
                    })}
                    <Button variant="light" size="xs" leftSection={<IconPlus size={14} />} w="fit-content" onClick={() => set({ complianceDeadlines: [...(answers.complianceDeadlines ?? []), { what: '', when: '' }] })}>Add deadline</Button>
                  </Stack>
                </Question>
              )}
              {step === 'Appetite' && (
                <>
                  <Question label="Budget appetite" hint="Sets the contingency: 5, 10 or 15 percent of the expected total.">
                    <SegmentedControl
                      value={answers.appetite ?? ''}
                      onChange={(v) => set({ appetite: v as BudgetAnswers['appetite'] })}
                      data={[
                        { value: 'lean', label: 'Lean' },
                        { value: 'balanced', label: 'Balanced' },
                        { value: 'cautious', label: 'Cautious' },
                      ]}
                    />
                  </Question>
                  <Question label="Notes" hint="Internal. Anything the client said that shapes the plan.">
                    <Textarea autosize minRows={2} value={answers.notes ?? ''} onChange={(e) => set({ notes: e.currentTarget.value })} />
                  </Question>
                </>
              )}
              <Group justify="space-between">
                <Button
                  variant="subtle"
                  size="xs"
                  disabled={step === BUDGET_STEPS[0]}
                  onClick={() => setStep(BUDGET_STEPS[Math.max(0, BUDGET_STEPS.indexOf(step) - 1)]!)}
                >
                  Back
                </Button>
                <Group gap="xs">
                  <Button variant="default" size="xs" loading={busy === 'save'} disabled={busy !== null} onClick={() => run('save')}>Save answers</Button>
                  <Button
                    variant="light"
                    size="xs"
                    disabled={step === BUDGET_STEPS[BUDGET_STEPS.length - 1]}
                    onClick={() => setStep(BUDGET_STEPS[Math.min(BUDGET_STEPS.length - 1, BUDGET_STEPS.indexOf(step) + 1)]!)}
                  >
                    Next
                  </Button>
                </Group>
              </Group>
            </Stack>
          </Card>
        </Grid.Col>

        <Grid.Col span={{ base: 12, lg: 3 }}>
          <Card withBorder padding="md" h="100%">
            <Group justify="space-between" mb="xs">
              <Text fw={700}>Industry context</Text>
              <Badge color="watch" variant="light">Internal only</Badge>
            </Group>
            <Text size="xs" c="dimmed" mb="sm">
              {plan?.context
                ? `Researched ${new Date(plan.context.researchedAt).toLocaleDateString()}${plan.context.sourced ? ' with web search' : ' without web search'}. Prep material for the conversation. None of this prints on the client report.`
                : 'Prep material for the conversation. None of this prints on the client report.'}
            </Text>
            {plan?.context?.items.length ? (
              <Stack gap="sm" mb="sm">
                {plan.context.items.map((item) => (
                  <div key={item.title}>
                    <Text size="sm" fw={600}>{item.title}</Text>
                    <Text size="sm">{item.insight}</Text>
                    <Text size="sm" c="dimmed">Ask: {item.askClient}</Text>
                    {item.sourceUrl && (
                      <Anchor size="xs" href={item.sourceUrl} target="_blank" rel="noopener noreferrer">{item.sourceName ?? 'Source'}</Anchor>
                    )}
                  </div>
                ))}
              </Stack>
            ) : null}
            {contextNote && <Text size="xs" c="watch" mb="xs">{contextNote}</Text>}
            <Button variant="light" size="xs" loading={busy === 'context'} disabled={busy !== null} onClick={() => run('context')}>
              {plan?.context ? 'Research again' : 'Research industry context'}
            </Button>
            <Alert color="watch" variant="light" mt="sm" p="xs">
              <Text size="xs">Guardrail: the client page carries only our bottom-up numbers. If a benchmark figure appears in client prose, the report fails verification the same way an unsourced metric does.</Text>
            </Alert>
          </Card>
        </Grid.Col>
      </Grid>

      <Card withBorder padding="md">
        <Group justify="space-between" mb="xs">
          <Text fw={700}>Outlook for fiscal year {fy}</Text>
          <Badge color="good" variant="light">Becomes the client page</Badge>
        </Group>
        {plan?.lines.length ? (
          <>
            <Table.ScrollContainer minWidth={640}>
              <Table verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Category</Table.Th>
                    <Table.Th ta="right">Low</Table.Th>
                    <Table.Th ta="right">Expected</Table.Th>
                    <Table.Th ta="right">High</Table.Th>
                    <Table.Th>Source of each number</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {plan.lines.map((l) => (
                    <Table.Tr key={l.category}>
                      <Table.Td>{CATEGORY_LABEL[l.category]}</Table.Td>
                      <Table.Td ta="right" style={{ fontVariantNumeric: 'tabular-nums' }}>{money(l.low)}</Table.Td>
                      <Table.Td ta="right" style={{ fontVariantNumeric: 'tabular-nums' }}>{money(l.expected)}</Table.Td>
                      <Table.Td ta="right" style={{ fontVariantNumeric: 'tabular-nums' }}>{money(l.high)}</Table.Td>
                      <Table.Td>
                        <Stack gap={2}>
                          {l.basis.map((b, i) => (
                            <Text key={i} size="xs" c="dimmed">
                              <Badge size="xs" variant="light" color="slate" mr={4} style={{ textTransform: 'none' }}>{SOURCE_LABEL[b.source]}</Badge>
                              {b.note}
                            </Text>
                          ))}
                        </Stack>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                  <Table.Tr fw={700}>
                    <Table.Td>Total</Table.Td>
                    <Table.Td ta="right">{money(plan.totals.low)}</Table.Td>
                    <Table.Td ta="right">{money(plan.totals.expected)}</Table.Td>
                    <Table.Td ta="right">{money(plan.totals.high)}</Table.Td>
                    <Table.Td />
                  </Table.Tr>
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            {plan.caveats.length > 0 && (
              <Alert color="watch" variant="light" mt="sm" title="Missing data">
                <Stack gap={4}>{plan.caveats.map((c) => <Text key={c} size="sm">{c}</Text>)}</Stack>
              </Alert>
            )}
          </>
        ) : (
          <Text size="sm" c="dimmed">No outlook yet. Answer what you can, then Re-run outlook.</Text>
        )}

        <SimpleGrid cols={{ base: 1, sm: 2 }} mt="md">
          <Textarea
            label="Assumptions shown to the client"
            description="One sentence per line."
            autosize
            minRows={2}
            value={assumptions}
            onChange={(e) => setAssumptions(e.currentTarget.value)}
          />
          <Textarea
            label="What would move it"
            description="One sentence per line."
            autosize
            minRows={2}
            value={movers}
            onChange={(e) => setMovers(e.currentTarget.value)}
          />
        </SimpleGrid>

        <SimpleGrid cols={{ base: 2, sm: 4 }} mt="md" spacing="xs">
          {actual ? (
            <>
              <Card bg="var(--mantine-color-slate-0)" padding="xs">
                <Text size="xs" c="dimmed">{actual.fiscalYearLabel} plan</Text>
                <Text fw={700} size="lg">{money(actual.planned)}</Text>
              </Card>
              <Card bg="var(--mantine-color-slate-0)" padding="xs">
                <Text size="xs" c="dimmed">Spent so far</Text>
                <Text fw={700} size="lg">{money(actual.spent)}</Text>
              </Card>
              <Card bg="var(--mantine-color-slate-0)" padding="xs">
                <Text size="xs" c="dimmed">Against plan</Text>
                <Text fw={700} size="lg" c={pvaTone(actual.note)}>{actual.pct}%</Text>
              </Card>
              <Card bg="var(--mantine-color-slate-0)" padding="xs">
                <Text size="xs" c="dimmed">Plan versus actual</Text>
                <Text size="xs">{actual.note}</Text>
              </Card>
            </>
          ) : (
            <Text size="xs" c="dimmed" style={{ gridColumn: '1 / -1' }}>
              Plan versus actual appears once a FY{year.currentLabel} plan is on the report and a quarter of that year is invoiced.
            </Text>
          )}
        </SimpleGrid>
      </Card>
    </Stack>
  );
}
