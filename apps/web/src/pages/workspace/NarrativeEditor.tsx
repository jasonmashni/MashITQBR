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
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPencil, IconSparkles } from '@tabler/icons-react';
import { api } from '../../api.js';
import type { ReportConfig, ReportModel } from '../../types.js';
import { toastError } from '../../toast.js';

// ── Narrative editor ──────────────────────────────────────────────────────────
const FOCUS_OPTIONS = [
  'Business security',
  'Business continuity',
  'Infrastructure & lifecycle',
  'Cost optimization',
  'Compliance readiness',
  'Service experience',
];

export function NarrativeEditor({
  clientId,
  period,
  model,
  aiEnabled,
  status,
  config,
  setConfig,
  onChanged,
}: {
  clientId: string;
  period: string;
  model: ReportModel;
  aiEnabled: boolean;
  status: string;
  config: ReportConfig | null;
  setConfig: (c: ReportConfig) => void;
  onChanged: () => void;
}) {
  const [headline, setHeadline] = useState(model.executive.headline ?? '');
  const [summary, setSummary] = useState(model.executive.paragraphs.join('\n\n'));
  const [highlights, setHighlights] = useState(model.executive.highlights.join('\n'));
  const [recommendations, setRecommendations] = useState(model.recommendations.join('\n'));
  const [editedBy, setEditedBy] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // AI direction (persisted in the report config; changing it re-drafts).
  const [focus, setFocus] = useState(config?.narrativeFocus ?? '');
  const [guidance, setGuidance] = useState(config?.narrativeGuidance ?? '');
  const [sectionNotes, setSectionNotes] = useState<Record<string, string>>(config?.sectionGuidance ?? {});
  const [openSection, setOpenSection] = useState<string | null>(null);

  useEffect(() => {
    api.getNarrative(clientId, period).then((d) => setEditedBy(d.edits ? `${d.edits.editedBy} · ${new Date(d.edits.editedAt).toLocaleString()}` : null)).catch(() => {});
  }, [clientId, period]);

  const splitLines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

  async function save() {
    setBusy('save');
    try {
      await api.putNarrative(clientId, period, {
        headline: headline.trim() || undefined,
        summary_paragraphs: summary.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean),
        highlights: splitLines(highlights),
        recommendations: splitLines(recommendations),
      });
      notifications.show({ color: 'teal', message: 'Narrative saved — no AI call needed.' });
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
      notifications.show({
        color: 'teal',
        message: aiEnabled ? 'Cleared — the next load drafts fresh AI text.' : 'Cleared — the offline drafter will rebuild the text.',
      });
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
      await api.putStatus(clientId, period, 'narrative_approved');
      notifications.show({ color: 'teal', message: 'Narrative approved.' });
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
   */
  async function applyDirection(notes: Record<string, string>, busyKey: string) {
    setBusy(busyKey);
    try {
      const cleanNotes = Object.fromEntries(Object.entries(notes).filter(([, v]) => v.trim() !== ''));
      const next: ReportConfig = {
        ...(config ?? { clientId }),
        clientId,
        narrativeFocus: focus.trim() || undefined,
        narrativeGuidance: guidance.trim() || undefined,
        sectionGuidance: Object.keys(cleanNotes).length ? cleanNotes : undefined,
      };
      await api.putConfig(clientId, next);
      setConfig(next);
      await api.regenerateNarrative(clientId, period);
      notifications.show({
        color: 'teal',
        message: aiEnabled ? 'Direction saved — regenerating the narrative with it.' : 'Direction saved (connect the AI key to use it).',
      });
      onChanged();
    } catch (e) {
      toastError('Could not apply direction', e);
    } finally {
      setBusy(null);
    }
  }

  const sections = model.sections ?? [];

  return (
    <Card withBorder radius="md" padding="lg">
      <Group justify="space-between" mb="sm">
        <Title order={5}>Narrative editor</Title>
        {editedBy && <Badge variant="light" color="yellow">edited · {editedBy}</Badge>}
      </Group>
      <Stack gap="sm">
        <TextInput label="Headline" value={headline} onChange={(e) => setHeadline(e.currentTarget.value)} />
        <Textarea label="Executive summary (blank line between paragraphs)" autosize minRows={4} value={summary} onChange={(e) => setSummary(e.currentTarget.value)} />
        <Textarea label="Highlights (one per line)" autosize minRows={2} value={highlights} onChange={(e) => setHighlights(e.currentTarget.value)} />
        <Textarea label="Recommendations (one per line)" autosize minRows={2} value={recommendations} onChange={(e) => setRecommendations(e.currentTarget.value)} />
        <Group>
          <Button loading={busy === 'save'} onClick={save}>Save narrative</Button>
          <Button variant="default" loading={busy === 'regen'} onClick={regenerate}>
            Regenerate {aiEnabled ? 'with AI' : ''}
          </Button>
          <Button
            variant="light"
            color="teal"
            loading={busy === 'approve'}
            disabled={status === 'narrative_approved'}
            onClick={approve}
          >
            Approve narrative
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          Edits are saved per client/quarter and always win over generated text — no regeneration happens when you tweak wording.
          Regenerate discards edits and the cached draft.
        </Text>

        <Divider label="AI direction" labelPosition="left" mt="xs" />
        <Group grow align="flex-start">
          <Autocomplete
            label="QBR focus"
            description="The theme this QBR should emphasize — pick one or type your own."
            placeholder="e.g. Business security"
            data={FOCUS_OPTIONS}
            value={focus}
            onChange={setFocus}
          />
        </Group>
        <Textarea
          label="Guidance for the AI"
          description="Standing instruction applied every time the narrative is drafted (e.g. “backup counts changed because we re-tuned monitoring — do not present that as a trend”)."
          autosize
          minRows={2}
          value={guidance}
          onChange={(e) => setGuidance(e.currentTarget.value)}
        />
        <Group>
          <Button
            variant="light"
            leftSection={<IconSparkles size={16} />}
            loading={busy === 'direction'}
            onClick={() => applyDirection(sectionNotes, 'direction')}
          >
            Save direction &amp; regenerate
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
                        color="teal"
                        aria-label={`Adjust ${s.title} summary`}
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
                        placeholder="What should change in this section? (e.g. “don't call the backup drop a decline — we re-tuned what we measure”)"
                        value={sectionNotes[s.category] ?? ''}
                        onChange={(e) => setSectionNotes({ ...sectionNotes, [s.category]: e.currentTarget.value })}
                      />
                      <Button
                        size="xs"
                        variant="light"
                        loading={busy === `section:${s.category}`}
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
              Section comments are remembered and applied on every regenerate — clear a comment and regenerate to drop it.
            </Text>
          </>
        )}
      </Stack>
    </Card>
  );
}
