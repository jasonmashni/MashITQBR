import { useEffect, useState } from 'react';
import {
  Title,
  Group,
  Button,
  Card,
  Text,
  Stack,
  TextInput,
  Textarea,
  Autocomplete,
  ActionIcon,
  Badge,
  Divider,
  Tooltip,
  Alert,
  Checkbox,
  SimpleGrid,
  List,
} from '@mantine/core';
import { IconPencil, IconPlus, IconSparkles, IconTrash } from '@tabler/icons-react';
import { isQbrStatus, statusAtLeast } from '@mashit/core';
import { api } from '../../api.js';
import type { NarrativeDecision, NarrativePlan, NarrativeProtection, PlanItem, ProtectionQuestionId, ReportConfig, ReportModel } from '../../types.js';
import { counterState, LIMITS, splitLines, styleHits, wordCount } from './narrativeLimits.js';

const QUESTIONS: Array<{ id: ProtectionQuestionId; question: string }> = [
  { id: 'get_in', question: 'Can someone get in?' },
  { id: 'know', question: 'Would we know, and how fast would we act?' },
  { id: 'recover', question: 'Could we recover?' },
  { id: 'keep_up', question: 'Are we keeping up?' },
  { id: 'run_well', question: 'Are we running it well?' },
];
const PLAN_COLUMNS: Array<{ key: keyof NarrativePlan; title: string }> = [
  { key: 'now', title: 'Now (next 30 days)' },
  { key: 'next', title: 'Next (31 to 60 days)' },
  { key: 'later', title: 'Later (61 to 90 days)' },
];

/** "7 of 12 words", red when over. */
function Counter({ text, limit }: { text: string; limit: number }) {
  const { count, over } = counterState(text, limit);
  return (
    <Text size="xs" c={over ? 'act.7' : 'dimmed'} fw={over ? 600 : undefined}>
      {count} of {limit} words
    </Text>
  );
}

/** "3 items (3 to 4)" plus any line over the bullet limit, red when out of range. */
function ListCounter({ text, min, max }: { text: string; min: number; max: number }) {
  const lines = splitLines(text);
  const long = lines.map((l, i) => ({ i, n: wordCount(l) })).filter((l) => l.n > LIMITS.bulletWords);
  const bad = lines.length < min || lines.length > max || long.length > 0;
  return (
    <Text size="xs" c={bad ? 'act.7' : 'dimmed'} fw={bad ? 600 : undefined}>
      {lines.length} {lines.length === 1 ? 'item' : 'items'} ({min} to {max}), each at most {LIMITS.bulletWords} words
      {long.length ? `. Over: ${long.map((l) => `line ${l.i + 1} (${l.n} words)`).join(', ')}` : ''}
    </Text>
  );
}

const protectionFromModel = (model: ReportModel): NarrativeProtection[] =>
  QUESTIONS.map((q) => {
    const row = model.protection?.find((r) => r.id === q.id);
    return { question: q.id, inPlace: row?.inPlace ?? '', thisQuarter: row?.thisQuarter ?? '' };
  });
const planFromModel = (model: ReportModel): NarrativePlan => ({
  now: model.plan?.now ?? [],
  next: model.plan?.next ?? [],
  later: model.plan?.later ?? [],
});
import { toastError, toastOk } from '../../toast.js';
import { ConfirmModal } from '../../ui.js';

const FOCUS_OPTIONS = [
  'Business security',
  'Business continuity',
  'Infrastructure & lifecycle',
  'Cost optimization',
  'Compliance readiness',
  'Service experience',
];

/**
 * Edit, regenerate and approve the narrative. Approve only moves forward;
 * Regenerate asks first because it discards edits and (with AI on) costs a
 * model call; the editor re-syncs from a fresh draft unless you have typed.
 */
export function NarrativeEditor({
  clientId,
  period,
  model,
  aiEnabled,
  status,
  verified,
  config,
  configError,
  setConfig,
  onChanged,
}: {
  clientId: string;
  period: string;
  model: ReportModel;
  aiEnabled: boolean;
  status: string;
  verified: boolean;
  config: ReportConfig | null;
  configError: string | null;
  setConfig: (c: ReportConfig) => void;
  onChanged: () => void;
}) {
  const [headline, setHeadline] = useState(model.executive.headline ?? '');
  const [lede, setLede] = useState(model.executive.lede ?? '');
  const [did, setDid] = useState((model.executive.did ?? []).join('\n'));
  const [saw, setSaw] = useState((model.executive.saw ?? []).join('\n'));
  const [decisions, setDecisions] = useState<NarrativeDecision[]>(model.decisions ?? []);
  const [plan, setPlan] = useState<NarrativePlan>(planFromModel(model));
  const [protection, setProtection] = useState<NarrativeProtection[]>(protectionFromModel(model));
  const [dirty, setDirty] = useState(false);
  const [editedBy, setEditedBy] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRegen, setConfirmRegen] = useState(false);
  // AI direction (persisted in the report config; changing it re-drafts).
  const [focus, setFocus] = useState(config?.narrativeFocus ?? '');
  const [guidance, setGuidance] = useState(config?.narrativeGuidance ?? '');
  const [sectionNotes, setSectionNotes] = useState<Record<string, string>>(config?.sectionGuidance ?? {});
  const [directionDirty, setDirectionDirty] = useState(false);
  const [openSection, setOpenSection] = useState<string | null>(null);

  // The direction fields follow the loaded config (it arrives after mount, and
  // changes on a client switch) unless the author has typed into them; seeding
  // once would let Save write blanks over the saved direction.
  useEffect(() => {
    if (directionDirty) return;
    setFocus(config?.narrativeFocus ?? '');
    setGuidance(config?.narrativeGuidance ?? '');
    setSectionNotes(config?.sectionGuidance ?? {});
  }, [config, directionDirty]);
  const editDirection = <T,>(set: (v: T) => void) => (v: T) => {
    setDirectionDirty(true);
    set(v);
  };

  // A fresh draft (after Sync or Regenerate) replaces the fields unless the
  // author is mid-edit; otherwise a stale Save would overwrite the new draft.
  useEffect(() => {
    if (dirty) return;
    setHeadline(model.executive.headline ?? '');
    setLede(model.executive.lede ?? '');
    setDid((model.executive.did ?? []).join('\n'));
    setSaw((model.executive.saw ?? []).join('\n'));
    setDecisions(model.decisions ?? []);
    setPlan(planFromModel(model));
    setProtection(protectionFromModel(model));
  }, [model, dirty]);

  useEffect(() => {
    api
      .getNarrative(clientId, period)
      .then((d) => setEditedBy(d.edits ? `Edited by ${d.edits.editedBy} on ${new Date(d.edits.editedAt).toLocaleString()}` : null))
      .catch(() => {});
  }, [clientId, period]);

  const approved = isQbrStatus(status) && statusAtLeast(status, 'narrative_approved');
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    setDirty(true);
    set(v);
  };

  async function save() {
    setBusy('save');
    try {
      const items = (list: PlanItem[]) => list.filter((p) => p.action.trim()).map((p) => ({ ...p, action: p.action.trim(), owner: p.owner.trim() || 'Mash IT' }));
      await api.putNarrative(clientId, period, {
        headline: headline.trim() || undefined,
        lede: lede.trim() || undefined,
        did: splitLines(did),
        saw: splitLines(saw),
        decisions: decisions
          .filter((d) => d.ask.trim())
          .map((d) => ({ ask: d.ask.trim(), ...(d.why?.trim() ? { why: d.why.trim() } : {}), ...(d.by?.trim() ? { by: d.by.trim() } : {}) })),
        plan: { now: items(plan.now), next: items(plan.next), later: items(plan.later) },
        protection: protection.map((p) => ({ ...p, inPlace: p.inPlace.trim(), thisQuarter: p.thisQuarter.trim() })),
      });
      setDirty(false);
      toastOk('Narrative saved.');
      onChanged();
    } catch (e) {
      toastError('Save failed', e);
    } finally {
      setBusy(null);
    }
  }

  async function regenerate() {
    setBusy('regen');
    try {
      await api.regenerateNarrative(clientId, period);
      setDirty(false);
      setConfirmRegen(false);
      toastOk(aiEnabled ? 'Regenerating the narrative.' : 'Regenerating the narrative with the offline drafter.');
      onChanged();
    } catch (e) {
      toastError('Regenerate failed', e);
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    setBusy('approve');
    try {
      await api.approveNarrative(clientId, period);
      toastOk('Narrative approved.');
      onChanged();
    } catch (e) {
      toastError('Approve failed', e);
    } finally {
      setBusy(null);
    }
  }

  /**
   * Persist focus/guidance/section comments into the report config, then clear
   * the cached draft so the next build re-drafts with the direction included.
   * Never writes when the settings failed to load: a stub would replace them.
   */
  async function applyDirection(notes: Record<string, string>, busyKey: string) {
    if (!config) return;
    setBusy(busyKey);
    try {
      const cleanNotes = Object.fromEntries(Object.entries(notes).filter(([, v]) => v.trim() !== ''));
      const next: ReportConfig = {
        ...config,
        clientId,
        narrativeFocus: focus.trim() || undefined,
        narrativeGuidance: guidance.trim() || undefined,
        sectionGuidance: Object.keys(cleanNotes).length ? cleanNotes : undefined,
      };
      await api.putConfig(clientId, next);
      setDirectionDirty(false);
      setConfig(next);
      await api.regenerateNarrative(clientId, period);
      setDirty(false);
      toastOk(aiEnabled ? 'Direction saved. Regenerating the narrative with it.' : 'Direction saved. Connect the AI key to use it.');
      onChanged();
    } catch (e) {
      toastError('Could not apply direction', e);
    } finally {
      setBusy(null);
    }
  }

  const sections = model.sections ?? [];
  // Approve signs off on what will ship: never unsaved text or an unverified figure.
  const approveBlocked = approved || dirty || !verified;
  const approveHint = approved
    ? 'Already approved for this quarter'
    : dirty
      ? 'Save your edits first; Approve signs off on the saved text.'
      : !verified
        ? 'A figure does not trace back to the data, or a field is over its limit. Fix it before approving.'
        : 'Marks the story ready to send. Forward only; reopening needs an override.';
  const directionLocked = !config;

  // Style hits per field, listed under the editor (advisory, like the server's lint).
  const style = [
    ...styleHits(headline).map((h) => `Headline: ${h}`),
    ...styleHits(lede).map((h) => `Opening paragraph: ${h}`),
    ...styleHits(did).map((h) => `What we did: ${h}`),
    ...styleHits(saw).map((h) => `What we saw: ${h}`),
    ...decisions.flatMap((d) => styleHits(`${d.ask} ${d.why ?? ''} ${d.by ?? ''}`).map((h) => `Decisions: ${h}`)),
    ...PLAN_COLUMNS.flatMap((c) => plan[c.key].flatMap((p) => styleHits(`${p.action} ${p.owner}`).map((h) => `Plan: ${h}`))),
    ...protection.flatMap((p) => styleHits(`${p.inPlace} ${p.thisQuarter}`).map((h) => `Protection: ${h}`)),
  ];
  const setPlanItem = (key: keyof NarrativePlan, i: number, patch: Partial<PlanItem>) =>
    edit(setPlan)({ ...plan, [key]: plan[key].map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const setDecision = (i: number, patch: Partial<NarrativeDecision>) => edit(setDecisions)(decisions.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const setProtectionField = (id: ProtectionQuestionId, patch: Partial<NarrativeProtection>) =>
    edit(setProtection)(protection.map((p) => (p.question === id ? { ...p, ...patch } : p)));

  return (
    <Card padding="lg">
      <Group justify="space-between" mb="sm">
        <Title order={5}>Narrative</Title>
        <Group gap="xs">
          {editedBy && <Badge color="watch">{editedBy}</Badge>}
          {approved && <Badge color="good">Approved</Badge>}
        </Group>
      </Group>
      {!verified && (
        <Alert color="act" variant="light" mb="sm" title="The narrative does not pass review yet">
          A number does not match the Data tab, or a field is over its word or item limit; the report notes say which. Edit the text or regenerate.
          The deliverables stay locked until this clears.
        </Alert>
      )}
      <Stack gap="sm">
        <TextInput label="Headline" value={headline} onChange={(e) => edit(setHeadline)(e.currentTarget.value)} description={<Counter text={headline} limit={LIMITS.headlineWords} />} />
        <Textarea
          label="Opening paragraph"
          autosize
          minRows={3}
          value={lede}
          onChange={(e) => edit(setLede)(e.currentTarget.value)}
          description={<Counter text={lede} limit={LIMITS.ledeWords} />}
        />
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <Textarea
            label="What we did (one per line)"
            autosize
            minRows={3}
            value={did}
            onChange={(e) => edit(setDid)(e.currentTarget.value)}
            description={<ListCounter text={did} min={LIMITS.didMin} max={LIMITS.didMax} />}
          />
          <Textarea
            label="What we saw (one per line)"
            autosize
            minRows={3}
            value={saw}
            onChange={(e) => edit(setSaw)(e.currentTarget.value)}
            description={<ListCounter text={saw} min={LIMITS.didMin} max={LIMITS.didMax} />}
          />
        </SimpleGrid>

        <div>
          <Group justify="space-between" mb={4}>
            <Text size="sm" fw={500}>What we need from you</Text>
            <Text size="xs" c={decisions.length > LIMITS.decisionsMax ? 'act.7' : 'dimmed'}>
              {decisions.length} of {LIMITS.decisionsMax} decisions
            </Text>
          </Group>
          <Stack gap={6}>
            {decisions.map((d, i) => (
              <Group key={i} gap="xs" wrap="nowrap" align="flex-start">
                <TextInput style={{ flex: 2 }} placeholder="What the client must decide" value={d.ask} onChange={(e) => setDecision(i, { ask: e.currentTarget.value })} aria-label={`Decision ${i + 1}`} />
                <TextInput style={{ flex: 2 }} placeholder="Why (optional)" value={d.why ?? ''} onChange={(e) => setDecision(i, { why: e.currentTarget.value })} aria-label={`Decision ${i + 1} reason`} />
                <TextInput style={{ flex: 1 }} placeholder="By when (optional)" value={d.by ?? ''} onChange={(e) => setDecision(i, { by: e.currentTarget.value })} aria-label={`Decision ${i + 1} date`} />
                <ActionIcon variant="subtle" color="act" aria-label={`Remove decision ${i + 1}`} onClick={() => edit(setDecisions)(decisions.filter((_, j) => j !== i))}>
                  <IconTrash size={15} />
                </ActionIcon>
              </Group>
            ))}
            <Group>
              <Button size="xs" variant="subtle" leftSection={<IconPlus size={14} />} disabled={decisions.length >= LIMITS.decisionsMax} onClick={() => edit(setDecisions)([...decisions, { ask: '' }])}>
                Add a decision
              </Button>
            </Group>
          </Stack>
        </div>

        <Divider label="The next 90 days" labelPosition="left" mt="xs" />
        <SimpleGrid cols={{ base: 1, md: 3 }}>
          {PLAN_COLUMNS.map((c) => (
            <Stack key={c.key} gap={6}>
              <Group justify="space-between">
                <Text size="sm" fw={600}>{c.title}</Text>
                <Text size="xs" c={plan[c.key].length > LIMITS.planPerColumn ? 'act.7' : 'dimmed'}>
                  {plan[c.key].length} of {LIMITS.planPerColumn}
                </Text>
              </Group>
              {plan[c.key].map((p, i) => (
                <Card key={i} withBorder padding="xs">
                  <Stack gap={4}>
                    <TextInput size="xs" placeholder="Action" value={p.action} onChange={(e) => setPlanItem(c.key, i, { action: e.currentTarget.value })} aria-label={`${c.title} action ${i + 1}`} />
                    <Group gap="xs" wrap="nowrap">
                      <TextInput size="xs" style={{ flex: 1 }} placeholder="Owner" value={p.owner} onChange={(e) => setPlanItem(c.key, i, { owner: e.currentTarget.value })} aria-label={`${c.title} owner ${i + 1}`} />
                      <ActionIcon variant="subtle" color="act" aria-label={`Remove ${c.title} item ${i + 1}`} onClick={() => edit(setPlan)({ ...plan, [c.key]: plan[c.key].filter((_, j) => j !== i) })}>
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Group>
                    <Checkbox size="xs" label="Needs the client's decision" checked={p.decision === true} onChange={(e) => setPlanItem(c.key, i, { decision: e.currentTarget.checked })} />
                  </Stack>
                </Card>
              ))}
              <Button
                size="xs"
                variant="subtle"
                leftSection={<IconPlus size={14} />}
                disabled={plan[c.key].length >= LIMITS.planPerColumn}
                onClick={() => edit(setPlan)({ ...plan, [c.key]: [...plan[c.key], { action: '', owner: 'Mash IT' }] })}
              >
                Add
              </Button>
            </Stack>
          ))}
        </SimpleGrid>

        <Divider label="How we are protecting you" labelPosition="left" mt="xs" />
        <Stack gap="sm">
          {QUESTIONS.map((q) => {
            const p = protection.find((x) => x.question === q.id) ?? { question: q.id, inPlace: '', thisQuarter: '' };
            return (
              <div key={q.id}>
                <Text size="sm" fw={600} mb={4}>{q.question}</Text>
                <SimpleGrid cols={{ base: 1, md: 2 }}>
                  <Textarea
                    label="What is in place"
                    autosize
                    minRows={2}
                    value={p.inPlace}
                    onChange={(e) => setProtectionField(q.id, { inPlace: e.currentTarget.value })}
                    description={<Counter text={p.inPlace} limit={LIMITS.protectionWords} />}
                  />
                  <Textarea
                    label="This quarter"
                    autosize
                    minRows={2}
                    value={p.thisQuarter}
                    onChange={(e) => setProtectionField(q.id, { thisQuarter: e.currentTarget.value })}
                    description={<Counter text={p.thisQuarter} limit={LIMITS.protectionWords} />}
                  />
                </SimpleGrid>
              </div>
            );
          })}
        </Stack>

        {style.length > 0 && (
          <Alert color="watch" variant="light" title="Wording to reconsider">
            <Text size="xs" mb={4}>Dashes and stock phrases make the prose read machine-written. They do not block approval.</Text>
            <List size="xs" spacing={2}>{style.map((h, i) => <List.Item key={i}>{h}</List.Item>)}</List>
          </Alert>
        )}
        <Group>
          <Button loading={busy === 'save'} onClick={save} disabled={!dirty}>
            Save narrative
          </Button>
          <Button variant="default" loading={busy === 'regen'} onClick={() => setConfirmRegen(true)}>
            Regenerate
          </Button>
          <Tooltip label={approveHint}>
            {/* data-disabled (not disabled) so the tooltip still explains why. */}
            <Button
              variant="light"
              color="good"
              loading={busy === 'approve'}
              data-disabled={approveBlocked || undefined}
              aria-disabled={approveBlocked}
              onClick={(e) => (approveBlocked ? e.preventDefault() : void approve())}
            >
              Approve narrative
            </Button>
          </Tooltip>
        </Group>
        <Text size="xs" c="dimmed">
          Saved wording always wins over generated text and never calls the model. Regenerate discards your edits and the cached draft.
          {approved ? ' Editing after approval keeps the approval; re-read before sending.' : ''}
        </Text>

        <Divider label="AI direction" labelPosition="left" mt="xs" />
        {directionLocked && (
          <Alert color="watch" variant="light">
            {configError ? `Report settings did not load (${configError}).` : 'Report settings are still loading.'} Direction can be saved once they are in.
          </Alert>
        )}
        <Group grow align="flex-start">
          <Autocomplete
            label="QBR focus"
            description="The theme this QBR should emphasize. Pick one or type your own."
            placeholder="e.g. Business security"
            data={FOCUS_OPTIONS}
            value={focus}
            onChange={editDirection(setFocus)}
            disabled={directionLocked}
          />
        </Group>
        <Textarea
          label="Guidance for the AI"
          description="A standing instruction applied every time the narrative is drafted, e.g. “backup counts changed because we re-tuned monitoring; do not present that as a trend”."
          autosize
          minRows={2}
          value={guidance}
          onChange={(e) => editDirection(setGuidance)(e.currentTarget.value)}
          disabled={directionLocked}
        />
        <Group>
          <Button
            variant="light"
            leftSection={<IconSparkles size={16} />}
            loading={busy === 'direction'}
            disabled={directionLocked}
            onClick={() => applyDirection(sectionNotes, 'direction')}
          >
            Save direction and regenerate
          </Button>
        </Group>

        {sections.length > 0 && (
          <>
            <Divider label="Section summaries" labelPosition="left" mt="xs" />
            <Stack gap="xs">
              {sections.map((s) => (
                <div key={s.category}>
                  <Group gap="xs" wrap="nowrap" align="flex-start">
                    <div style={{ flex: 1 }}>
                      <Text size="sm" fw={600}>{s.title}</Text>
                      <Text size="xs" c="dimmed">{s.summary ?? 'No summary drafted for this section yet.'}</Text>
                    </div>
                    <Tooltip label="Comment on this section and regenerate">
                      <ActionIcon
                        variant={openSection === s.category || sectionNotes[s.category] ? 'light' : 'subtle'}
                        color="brand"
                        aria-label={`Adjust the ${s.title} summary`}
                        disabled={directionLocked}
                        onClick={() => setOpenSection(openSection === s.category ? null : s.category)}
                      >
                        <IconPencil size={15} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                  {openSection === s.category && (
                    <Group mt={6} gap="xs" align="flex-start" wrap="nowrap">
                      <Textarea
                        style={{ flex: 1 }}
                        autosize
                        minRows={1}
                        placeholder="What should change in this section? e.g. “don't call the backup drop a decline; we re-tuned what we measure”"
                        value={sectionNotes[s.category] ?? ''}
                        onChange={(e) => editDirection(setSectionNotes)({ ...sectionNotes, [s.category]: e.currentTarget.value })}
                      />
                      <Button
                        size="xs"
                        variant="light"
                        loading={busy === `section:${s.category}`}
                        disabled={directionLocked}
                        onClick={() => applyDirection(sectionNotes, `section:${s.category}`)}
                      >
                        Regenerate
                      </Button>
                    </Group>
                  )}
                </div>
              ))}
            </Stack>
            <Text size="xs" c="dimmed">
              Section comments are remembered and applied on every regenerate. Clear a comment and regenerate to drop it.
            </Text>
          </>
        )}
      </Stack>
      <ConfirmModal
        opened={confirmRegen}
        title="Regenerate the narrative?"
        confirmLabel="Regenerate"
        loading={busy === 'regen'}
        onCancel={() => setConfirmRegen(false)}
        onConfirm={regenerate}
      >
        <Text size="sm">This discards your saved edits and the cached draft.{aiEnabled ? ' With AI on, it makes a paid model call.' : ''}</Text>
        {approved && (
          <Text size="sm" c="watch.8" mt="xs">
            The narrative is already approved. Re-read the new draft before sending the package.
          </Text>
        )}
      </ConfirmModal>
    </Card>
  );
}
