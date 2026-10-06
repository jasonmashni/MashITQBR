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
  Fieldset,
  Badge,
  Divider,
  Modal,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconTicket, IconTargetArrow } from '@tabler/icons-react';
import { api } from '../../api.js';
import type { Discussion, DiscussionItem, HaloMeta } from '../../types.js';
import { toastError } from '../../toast.js';
import { HaloFields, EMPTY_HALO_FIELDS, type HaloFieldValues } from './HaloFields.js';

// ── Actions tab: push dispositioned items with full Halo field control ────────
export function ActionsTab({
  clientId,
  period,
  disc,
  onChanged,
}: {
  clientId: string;
  period: string;
  disc: Discussion | null;
  onChanged: () => void;
}) {
  const [pushing, setPushing] = useState<string | null>(null);
  const [ticketItem, setTicketItem] = useState<DiscussionItem | null>(null);

  async function pushSimple(actionId: string, target: string) {
    setPushing(actionId + target);
    try {
      const r = await api.pushAction(clientId, period, { actionId, target });
      notifications.show({ color: 'teal', title: 'Pushed', message: `${r.system} #${r.id || '(created)'}` });
      onChanged();
    } catch (e) {
      toastError('Push failed', e);
    } finally {
      setPushing(null);
    }
  }

  const items = disc?.items ?? [];

  return (
    <Stack gap="lg" maw={860}>
      <Card withBorder radius="md" padding="lg">
        <Title order={5} mb="md">Push actions</Title>
        <Text c="dimmed" size="sm" mb="md">
          Turn discussion outcomes into work: Halo tickets open a form where you set the type, agent, team and priority before pushing.
        </Text>
        {items.length === 0 ? (
          <Text size="sm" c="dimmed">No discussion items — capture them on the Meeting tab first.</Text>
        ) : (
          <Stack>
            {items.map((it) => (
              <Fieldset key={it.id} p="sm">
                <Group justify="space-between" align="flex-start">
                  <div style={{ flex: 1 }}>
                    <Text fw={600} size="sm">{it.topic || '(untitled)'}</Text>
                    {it.response && <Text size="xs" c="dimmed" lineClamp={2}>{it.response}</Text>}
                  </div>
                  {it.externalRef && (
                    <Badge color="green" variant="light">
                      {it.externalRef.system} #{it.externalRef.id}
                      {it.externalRef.status ? ` · ${it.externalRef.status}` : ''}
                    </Badge>
                  )}
                </Group>
                <Divider my="xs" />
                {it.externalRef ? (
                  // Already pushed: a second push would create a duplicate ticket or opportunity.
                  <Text size="xs" c="dimmed">
                    Pushed to {it.externalRef.system} as #{it.externalRef.id}. Follow it up there; this item will not be pushed again.
                  </Text>
                ) : (
                  <Group gap="xs">
                    <Button
                      size="xs"
                      variant={it.disposition === 'create_ticket' ? 'filled' : 'light'}
                      leftSection={<IconTicket size={14} />}
                      onClick={() => setTicketItem(it)}
                    >
                      Create a Halo ticket
                    </Button>
                    <Button
                      size="xs"
                      variant={it.disposition === 'create_opportunity' ? 'filled' : 'light'}
                      color="good"
                      leftSection={<IconTargetArrow size={14} />}
                      loading={pushing === it.id + 'halo_opportunity'}
                      disabled={pushing !== null && pushing !== it.id + 'halo_opportunity'}
                      onClick={() => pushSimple(it.id, 'halo_opportunity')}
                    >
                      Create a Halo opportunity
                    </Button>
                    <Button
                      size="xs"
                      variant="light"
                      color="navy"
                      leftSection={<IconTargetArrow size={14} />}
                      loading={pushing === it.id + 'zomentum_opportunity'}
                      disabled={pushing !== null && pushing !== it.id + 'zomentum_opportunity'}
                      onClick={() => pushSimple(it.id, 'zomentum_opportunity')}
                    >
                      Create a Zomentum opportunity
                    </Button>
                  </Group>
                )}
              </Fieldset>
            ))}
          </Stack>
        )}
      </Card>

      {ticketItem && (
        <HaloTicketModal
          item={ticketItem}
          clientId={clientId}
          period={period}
          onClose={() => setTicketItem(null)}
          onPushed={() => {
            setTicketItem(null);
            onChanged();
          }}
        />
      )}
    </Stack>
  );
}

/** Halo ticket push with full field control — type, agent, team, priority. */
function HaloTicketModal({
  item,
  clientId,
  period,
  onClose,
  onPushed,
}: {
  item: DiscussionItem;
  clientId: string;
  period: string;
  onClose: () => void;
  onPushed: () => void;
}) {
  const [meta, setMeta] = useState<HaloMeta | null>(null);
  const [metaNote, setMetaNote] = useState<string | null>(null);
  const [summary, setSummary] = useState(item.topic);
  const [details, setDetails] = useState(item.response ?? '');
  const [halo, setHalo] = useState<HaloFieldValues>(EMPTY_HALO_FIELDS);
  const [pushing, setPushing] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .haloMeta()
      .then((m) => live && setMeta(m))
      .catch((e) => live && setMetaNote(e instanceof Error ? e.message : 'Halo lookup lists unavailable — the ticket still pushes with summary + details.'));
    return () => {
      live = false;
    };
  }, []);

  async function push() {
    if (!summary.trim()) {
      notifications.show({ color: 'red', message: 'A summary is required.' });
      return;
    }
    setPushing(true);
    try {
      const r = await api.pushAction(clientId, period, {
        actionId: item.id,
        target: 'halo_ticket',
        title: summary.trim(),
        detail: details,
        ticketTypeId: halo.ticketTypeId ?? undefined,
        agentId: halo.agentId ?? undefined,
        team: halo.team ?? undefined,
        priorityId: halo.priorityId ?? undefined,
      });
      notifications.show({ color: 'teal', title: 'Ticket created', message: `Halo #${r.id}${r.status ? ` · ${r.status}` : ''}` });
      onPushed();
    } catch (e) {
      toastError('Push failed', e);
    } finally {
      setPushing(false);
    }
  }

  return (
    <Modal opened onClose={onClose} title="Create Halo ticket" size="lg">
      <Stack>
        <TextInput label="Summary" required value={summary} onChange={(e) => setSummary(e.currentTarget.value)} />
        <Textarea label="Details" autosize minRows={3} value={details} onChange={(e) => setDetails(e.currentTarget.value)} />
        {metaNote && <Text size="xs" c="dimmed">{metaNote}</Text>}
        <HaloFields meta={meta} value={halo} onChange={setHalo} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button loading={pushing} leftSection={<IconTicket size={16} />} onClick={push}>Create ticket</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
