import { Group, Select } from '@mantine/core';
import type { HaloMeta } from '../../types.js';

/** The Halo routing fields a pushed ticket can carry; null means "Halo's default". */
export interface HaloFieldValues {
  ticketTypeId: string | null;
  agentId: string | null;
  team: string | null;
  priorityId: string | null;
}

export const EMPTY_HALO_FIELDS: HaloFieldValues = { ticketTypeId: null, agentId: null, team: null, priorityId: null };

const opts = (rows: Array<{ id: string; name: string }> | undefined) => (rows ?? []).map((r) => ({ value: r.id, label: r.name }));

// ── Shared Halo ticket selects: type, priority, agent, team ──────────────────
export function HaloFields({
  meta,
  value,
  onChange,
}: {
  meta: HaloMeta | null;
  value: HaloFieldValues;
  onChange: (v: HaloFieldValues) => void;
}) {
  const set = (patch: Partial<HaloFieldValues>) => onChange({ ...value, ...patch });
  return (
    <>
      <Group grow>
        <Select
          label="Ticket type"
          placeholder={meta ? 'Default' : 'Loading…'}
          data={opts(meta?.ticketTypes)}
          value={value.ticketTypeId}
          onChange={(v) => set({ ticketTypeId: v })}
          searchable
          clearable
        />
        <Select
          label="Priority"
          placeholder={meta ? 'Default' : 'Loading…'}
          data={opts(meta?.priorities)}
          value={value.priorityId}
          onChange={(v) => set({ priorityId: v })}
          clearable
        />
      </Group>
      <Group grow>
        <Select
          label="Assign to agent"
          placeholder={meta ? 'Unassigned' : 'Loading…'}
          data={opts(meta?.agents)}
          value={value.agentId}
          onChange={(v) => set({ agentId: v })}
          searchable
          clearable
        />
        <Select
          label="Team"
          placeholder={meta ? 'Default' : 'Loading…'}
          data={(meta?.teams ?? []).map((t) => ({ value: t.name, label: t.name }))}
          value={value.team}
          onChange={(v) => set({ team: v })}
          searchable
          clearable
        />
      </Group>
    </>
  );
}
