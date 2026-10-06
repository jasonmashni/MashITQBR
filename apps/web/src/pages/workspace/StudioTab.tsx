import { useEffect, useState } from 'react';
import {
  Title,
  Group,
  Button,
  Select,
  Card,
  Text,
  Stack,
  SimpleGrid,
  Loader,
  Center,
  TextInput,
  Textarea,
  Checkbox,
  Fieldset,
  ActionIcon,
  FileButton,
  Image,
  Anchor,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconTrash, IconPlus, IconBulb, IconSparkles } from '@tabler/icons-react';
import { api } from '../../api.js';
import type { ClientGoal, ClientGoalStatus, ReportConfig } from '../../types.js';
import { uid } from '../../ui.js';
import { toastError } from '../../toast.js';
import { SECTIONS } from './shared.js';

// ── Studio tab: shape the report (branding + sections) ────────────────────────
const GOAL_STATUS_OPTIONS: Array<{ value: ClientGoalStatus; label: string; color: string }> = [
  { value: 'planned', label: 'Planned', color: 'gray' },
  { value: 'on_track', label: 'On track', color: 'teal' },
  { value: 'at_risk', label: 'At risk', color: 'yellow' },
  { value: 'achieved', label: 'Achieved', color: 'cyan' },
];

/**
 * Strategic goals editor (Studio tab). Records the client's business objectives
 * and how IT supports them — these open the report and steer the AI narrative.
 * Loads/saves the whole list on the client record via a dedicated endpoint.
 */
type ResearchResult = {
  summary: string;
  trends: Array<{ title: string; insight: string; relevance: string; sourceName?: string; sourceUrl?: string }>;
  suggestedGoals: Array<{ title: string; alignment: string }>;
  recommendations: string[];
  sourced: boolean;
};

function GoalsEditor({ clientId, onSaved }: { clientId: string; onSaved: () => void }) {
  const [goals, setGoals] = useState<ClientGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [research, setResearch] = useState<ResearchResult | null>(null);
  const [researching, setResearching] = useState(false);
  const [researchNote, setResearchNote] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .getClient(clientId)
      .then((d) => live && setGoals(d.client.goals ?? []))
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [clientId]);

  const rid = () => Math.random().toString(36).slice(2, 10);
  const add = () => setGoals((g) => [...g, { id: rid(), title: '', status: 'planned' }]);
  const patch = (id: string, p: Partial<ClientGoal>) => setGoals((g) => g.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const remove = (id: string) => setGoals((g) => g.filter((x) => x.id !== id));

  // Append a researched suggestion as an editable goal (user reviews, then Save).
  const addSuggestedGoal = (title: string, alignment?: string) => {
    setGoals((g) => [...g, { id: rid(), title, alignment, status: 'planned' }]);
    notifications.show({ color: 'teal', message: 'Added below — review it, then Save goals.' });
  };

  async function runResearch() {
    setResearching(true);
    setResearchNote('');
    try {
      const r = await api.researchClient(clientId);
      if (!r.available || !r.research) {
        setResearchNote(r.note ?? 'Research is unavailable right now.');
        setResearch(null);
      } else {
        setResearch(r.research);
        if (!r.research.sourced) setResearchNote('Live web search was unavailable — this reflects the model\'s general knowledge, so verify before acting.');
      }
    } catch (e) {
      setResearchNote(e instanceof Error ? e.message : 'Research failed.');
    } finally {
      setResearching(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      // Drop blank rows; the endpoint validates too.
      const cleaned = goals.filter((g) => g.title.trim());
      const res = await api.putClientGoals(clientId, cleaned);
      setGoals(res.client.goals ?? []);
      notifications.show({ color: 'teal', message: 'Goals saved — they open the report and steer the narrative.' });
      onSaved();
    } catch (e) {
      toastError('Save failed', e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
    <Card withBorder radius="md" padding="lg">
      <Group justify="space-between" mb={4}>
        <Title order={5}>Strategic goals &amp; alignment</Title>
        <Button size="compact-sm" variant="light" leftSection={<IconPlus size={14} />} onClick={add}>
          Add goal
        </Button>
      </Group>
      <Text size="xs" c="dimmed" mb="md">
        The client's business objectives and how Mash IT supports them. These open the QBR (a "Strategic Goals &amp; IT
        Alignment" section) and give the AI narrative context to frame the quarter around what the client is working toward.
        Keep them qualitative — no figures.
      </Text>
      {loading ? (
        <Center h={80}><Loader size="sm" /></Center>
      ) : goals.length === 0 ? (
        <Text size="sm" c="dimmed">No goals yet. Add the client's top 2–4 objectives for the year.</Text>
      ) : (
        <Stack gap="md">
          {goals.map((g) => (
            <Card key={g.id} withBorder radius="sm" padding="sm" bg="var(--mantine-color-gray-0)">
              <Stack gap="xs">
                <Group align="flex-start" wrap="nowrap">
                  <TextInput
                    style={{ flex: 1 }}
                    placeholder="Goal — e.g. Open two new clinics by year-end"
                    value={g.title}
                    onChange={(e) => patch(g.id, { title: e.currentTarget.value })}
                  />
                  <ActionIcon color="red" variant="subtle" aria-label="Remove goal" onClick={() => remove(g.id)} mt={4}>
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
                <Textarea
                  placeholder="How our services support it (qualitative)"
                  autosize
                  minRows={1}
                  value={g.alignment ?? ''}
                  onChange={(e) => patch(g.id, { alignment: e.currentTarget.value })}
                />
                <Group gap="sm">
                  <Select
                    w={150}
                    data={GOAL_STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                    value={g.status}
                    onChange={(v) => v && patch(g.id, { status: v as ClientGoalStatus })}
                    allowDeselect={false}
                  />
                  <TextInput
                    w={140}
                    placeholder="Target e.g. 2026-Q4"
                    value={g.targetPeriod ?? ''}
                    onChange={(e) => patch(g.id, { targetPeriod: e.currentTarget.value || undefined })}
                  />
                </Group>
              </Stack>
            </Card>
          ))}
        </Stack>
      )}
      <Group justify="flex-end" mt="md">
        <Button loading={saving} onClick={save} disabled={loading}>Save goals</Button>
      </Group>
    </Card>

    <Card withBorder radius="md" padding="lg">
      <Group justify="space-between" mb={4}>
        <Title order={5}>Market &amp; industry intelligence</Title>
        <Button
          size="compact-sm"
          variant="light"
          color="teal"
          loading={researching}
          leftSection={<IconSparkles size={14} />}
          onClick={runResearch}
        >
          {research ? 'Refresh' : 'Research'}
        </Button>
      </Group>
      <Text size="xs" c="dimmed" mb="md">
        Recent, sourced developments in this client's industry and region that could shape their IT, security, or
        compliance priorities — plus goals worth proposing. For your prep; nothing is added to the report automatically.
      </Text>
      {researching ? (
        <Stack gap="xs" align="center" py="xl">
          <Loader size="sm" />
          <Text size="xs" c="dimmed">Researching the client and their industry…</Text>
        </Stack>
      ) : research ? (
        <Stack gap="md">
          {research.summary && <Text size="sm">{research.summary}</Text>}
          {researchNote && <Text size="xs" c="orange.7">{researchNote}</Text>}
          {research.trends.length > 0 && (
            <div>
              <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={6}>Trends &amp; news</Text>
              <Stack gap="sm">
                {research.trends.map((t, i) => (
                  <Card key={i} withBorder radius="sm" padding="sm" bg="var(--mantine-color-gray-0)">
                    <Text size="sm" fw={600}>{t.title}</Text>
                    {t.insight && <Text size="xs" mt={2}>{t.insight}</Text>}
                    {t.relevance && <Text size="xs" c="dimmed" mt={4}><b>Why it matters:</b> {t.relevance}</Text>}
                    {t.sourceUrl && (
                      <Anchor href={t.sourceUrl} target="_blank" rel="noreferrer" size="xs" mt={4} style={{ display: 'inline-block' }}>
                        {t.sourceName || 'Source'} ↗
                      </Anchor>
                    )}
                  </Card>
                ))}
              </Stack>
            </div>
          )}
          {research.suggestedGoals.length > 0 && (
            <div>
              <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={6}>Suggested goals</Text>
              <Stack gap="xs">
                {research.suggestedGoals.map((g, i) => (
                  <Group key={i} justify="space-between" wrap="nowrap" align="flex-start" gap="sm">
                    <div style={{ minWidth: 0 }}>
                      <Text size="sm" fw={500}>{g.title}</Text>
                      {g.alignment && <Text size="xs" c="dimmed">{g.alignment}</Text>}
                    </div>
                    <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} style={{ flex: '0 0 auto' }} onClick={() => addSuggestedGoal(g.title, g.alignment)}>
                      Add
                    </Button>
                  </Group>
                ))}
              </Stack>
            </div>
          )}
          {research.recommendations.length > 0 && (
            <div>
              <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={6}>Recommendations</Text>
              <Stack gap="xs">
                {research.recommendations.map((r, i) => (
                  <Group key={i} justify="space-between" wrap="nowrap" align="flex-start" gap="sm">
                    <Text size="sm" style={{ minWidth: 0 }}>{r}</Text>
                    <Button size="compact-xs" variant="subtle" leftSection={<IconPlus size={12} />} style={{ flex: '0 0 auto' }} onClick={() => addSuggestedGoal(r)}>
                      Add as goal
                    </Button>
                  </Group>
                ))}
              </Stack>
            </div>
          )}
        </Stack>
      ) : (
        <Stack gap="xs" align="center" py="xl">
          <IconBulb size={22} color="var(--mantine-color-teal-6)" />
          <Text size="sm" c="dimmed" ta="center" maw={300}>
            {researchNote || 'Click Research to pull recent industry trends, relevant news, and goal ideas for this client.'}
          </Text>
        </Stack>
      )}
    </Card>
    </SimpleGrid>
  );
}

export function StudioTab({
  config,
  setConfig,
  clientId,
  onSaved,
}: {
  config: ReportConfig;
  setConfig: (c: ReportConfig) => void;
  clientId: string;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const brand = config.brand ?? {};

  function onLogo(file: File | null) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setConfig({ ...config, brand: { ...brand, logoDataUri: String(reader.result) } });
    reader.readAsDataURL(file);
  }

  async function save() {
    setSaving(true);
    try {
      await api.putConfig(clientId, { ...config, clientId });
      notifications.show({ color: 'teal', message: 'Saved. The report reflects it instantly — AI text is reused.' });
      onSaved();
    } catch (e) {
      toastError('Save failed', e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap="lg" maw={760}>
      <GoalsEditor clientId={clientId} onSaved={onSaved} />

      <Card withBorder radius="md" padding="lg">
        <Title order={5} mb={4}>Client branding</Title>
        <Text size="xs" c="dimmed" mb="md">
          Reports always use the Mash IT theme (colors and logo from Settings) — the client's logo shows alongside it on the
          report, PDF and deck for the personal touch.
        </Text>
        <Stack>
          <TextInput label="Client display name override" value={brand.name ?? ''} onChange={(e) => setConfig({ ...config, brand: { ...brand, name: e.currentTarget.value } })} />
          <Group align="flex-end">
            <FileButton accept="image/*" onChange={onLogo}>
              {(props) => <Button variant="default" {...props}>Upload client logo</Button>}
            </FileButton>
            {brand.logoDataUri && <Image src={brand.logoDataUri} h={40} w="auto" fit="contain" alt="logo" />}
            {brand.logoDataUri && (
              <Button variant="subtle" color="red" onClick={() => setConfig({ ...config, brand: { ...brand, logoDataUri: undefined } })}>
                Remove logo
              </Button>
            )}
          </Group>
        </Stack>
      </Card>

      <Card withBorder radius="md" padding="lg">
        <Title order={5} mb="md">Sections</Title>
        <Stack gap="xs">
          {SECTIONS.map(([key, label]) => {
            const hidden = config.hiddenSections?.includes(key) ?? false;
            return (
              <Checkbox
                key={key}
                label={label}
                checked={!hidden}
                onChange={(e) => {
                  const set = new Set(config.hiddenSections ?? []);
                  if (e.currentTarget.checked) set.delete(key);
                  else set.add(key);
                  setConfig({ ...config, hiddenSections: [...set] });
                }}
              />
            );
          })}
        </Stack>
      </Card>

      <Card withBorder radius="md" padding="lg">
        <Group justify="space-between" mb="md">
          <Title order={5}>Custom sections</Title>
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setConfig({ ...config, customSections: [...(config.customSections ?? []), { id: uid(), title: '', body: '', placement: 'in-body' }] })}>Add section</Button>
        </Group>
        <Stack>
          {(config.customSections ?? []).map((s, i) => (
            <Fieldset key={s.id} p="sm">
              <Group align="flex-end" mb="xs">
                <TextInput label="Title" style={{ flex: 1 }} value={s.title} onChange={(e) => { const cs = [...(config.customSections ?? [])]; cs[i] = { ...s, title: e.currentTarget.value }; setConfig({ ...config, customSections: cs }); }} />
                <Select
                  label="Placement"
                  w={150}
                  data={[{ value: 'after-summary', label: 'After summary' }, { value: 'in-body', label: 'In body' }, { value: 'end', label: 'At end' }]}
                  value={s.placement ?? 'in-body'}
                  onChange={(v) => { const cs = [...(config.customSections ?? [])]; cs[i] = { ...s, placement: v ?? 'in-body' }; setConfig({ ...config, customSections: cs }); }}
                />
                <ActionIcon color="red" variant="subtle" aria-label="Remove section" onClick={() => setConfig({ ...config, customSections: (config.customSections ?? []).filter((x) => x.id !== s.id) })}><IconTrash size={16} /></ActionIcon>
              </Group>
              <Textarea autosize minRows={2} placeholder="Body" value={s.body} onChange={(e) => { const cs = [...(config.customSections ?? [])]; cs[i] = { ...s, body: e.currentTarget.value }; setConfig({ ...config, customSections: cs }); }} />
            </Fieldset>
          ))}
        </Stack>
      </Card>

      <Group><Button loading={saving} onClick={save}>Save</Button></Group>
    </Stack>
  );
}
