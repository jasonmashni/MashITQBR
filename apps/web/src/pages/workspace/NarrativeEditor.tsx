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
} from '@mantine/core';
import { IconPencil, IconSparkles } from '@tabler/icons-react';
import { isQbrStatus, statusAtLeast } from '@mashit/core';
import { api } from '../../api.js';
import type { ReportConfig, ReportModel } from '../../types.js';
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
  const [summary, setSummary] = useState(model.executive.paragraphs.join('\n\n'));
  const [highlights, setHighlights] = useState(model.executive.highlights.join('\n'));
  const [recommendations, setRecommendations] = useState(model.recommendations.join('\n'));
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
    setSummary(model.executive.paragraphs.join('\n\n'));
    setHighlights(model.executive.highlights.join('\n'));
    setRecommendations(model.recommendations.join('\n'));
  }, [model, dirty]);

  useEffect(() => {
    api
      .getNarrative(clientId, period)
      .then((d) => setEditedBy(d.edits ? `Edited by ${d.edits.editedBy} on ${new Date(d.edits.editedAt).toLocaleString()}` : null))
      .catch(() => {});
  }, [clientId, period]);

  const splitLines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);
  const approved = isQbrStatus(status) && statusAtLeast(status, 'narrative_approved');
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    setDirty(true);
    set(v);
  };

  async function save() {
    setBusy('save');
    try {
      await api.putNarrative(clientId, period, {
        headline: headline.trim() || undefined,
        summary_paragraphs: summary.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean),
        highlights: splitLines(highlights),
        recommendations: splitLines(recommendations),
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
        ? 'A figure does not trace back to the data. Fix it before approving.'
        : 'Marks the story ready to send. Forward only; reopening needs an override.';
  const directionLocked = !config;

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
        <Alert color="act" variant="light" mb="sm" title="A figure does not trace back to the data">
          Edit the text so every number matches the Data tab, or regenerate. The deliverables stay locked until this clears.
        </Alert>
      )}
      <Stack gap="sm">
        <TextInput label="Headline" value={headline} onChange={(e) => edit(setHeadline)(e.currentTarget.value)} />
        <Textarea label="Executive summary (blank line between paragraphs)" autosize minRows={4} value={summary} onChange={(e) => edit(setSummary)(e.currentTarget.value)} />
        <Textarea label="Highlights (one per line)" autosize minRows={2} value={highlights} onChange={(e) => edit(setHighlights)(e.currentTarget.value)} />
        <Textarea label="Recommendations (one per line)" autosize minRows={2} value={recommendations} onChange={(e) => edit(setRecommendations)(e.currentTarget.value)} />
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
