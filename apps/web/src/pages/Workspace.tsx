import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Tabs, Text, Stack, Alert, Loader, Center, Badge, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { api, reportUrls } from '../api.js';
import { lastPeriods } from '../periods.js';
import type { Client, Discussion, QbrResponse, SystemInfo } from '../types.js';
import { useResource } from '../hooks/useResource.js';
import { toastError } from '../toast.js';
import { WorkspaceHeader } from './workspace/WorkspaceHeader.js';
import { PipelineStepper } from './workspace/PipelineStepper.js';
import { OverviewTab } from './workspace/OverviewTab.js';
import { DataTab } from './workspace/DataTab.js';
import { ReportsTab } from './workspace/ReportsTab.js';
import { MeetingTab } from './workspace/MeetingTab.js';
import { ActionsTab } from './workspace/ActionsTab.js';
import { OpportunitiesTab } from './workspace/OpportunitiesTab.js';
import { StudioTab } from './workspace/StudioTab.js';

/**
 * The QBR workspace, organized around the working flow: everything you
 * deliver is one click in the sticky header; the tabs follow the lifecycle —
 * Overview (what the client sees), Data (what feeds it), Meeting (prep + run
 * the review), Actions (what happens after), Studio (shape the report).
 */
export function Workspace() {
  const { clientId = '' } = useParams();
  // The selected quarter lives in the URL (?period=) so a browser refresh
  // stays on the quarter you were viewing instead of jumping to the current
  // one — and a notification deep link re-runs the targeting effect even when
  // we're already on this client (useParams alone wouldn't remount).
  const [searchParams, setSearchParams] = useSearchParams();
  const wantedPeriod = searchParams.get('period');
  // Persist the selected quarter in the URL. Build a FRESH URLSearchParams
  // (mutating the existing one is unreliable in React Router) so the change
  // always lands and survives a refresh.
  const selectPeriod = (p: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('period', p);
    setSearchParams(next, { replace: true });
  };
  const [periods, setPeriods] = useState<Array<{ value: string; label: string }>>([]);
  const [periodList, setPeriodList] = useState<Array<{ period: string; hasSnapshot: boolean; status?: string }>>([]);
  const [period, setPeriod] = useState('');
  const [qbr, setQbr] = useState<QbrResponse | null>(null);
  // Report settings: a failed load stays an error (no `{ clientId }` stand-in
  // that a later Save would write over the real settings).
  const configRes = useResource(() => api.getConfig(clientId), [clientId]);
  const config = configRes.data ?? null;
  const setConfig = configRes.setData;
  const [disc, setDisc] = useState<Discussion | null>(null);
  const [client, setClient] = useState<Client | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [tab, setTab] = useState<string>('overview');
  // Unsaved-work guards: a refresh must not clobber a mid-meeting agenda, and
  // leaving the Data tab with staged review changes should ask first.
  const discDirty = useRef(false);
  const dataDirty = useRef(false);
  const discKey = useRef('');

  useEffect(() => {
    // Switching clients: clear stale report state so the header + tabs never
    // show the previous client's data while the new one loads.
    setClient(null);
    setQbr(null);
    setError(null);
    api.listClients().then((d) => setClient(d.clients.find((c) => c.id === clientId) ?? null)).catch(() => {});
    api.system().then(setSystem).catch(() => {});
  }, [clientId]);

  // Reports needing attention: uncategorized files (fresh inbox arrivals land
  // without a category until matched/filed) — surfaces a dot on the tab.
  const [unfiled, setUnfiled] = useState(0);
  useEffect(() => {
    let live = true;
    api
      .listClientDocuments(clientId)
      .then((d) => live && setUnfiled(d.documents.filter((doc) => !doc.category).length))
      .catch(() => live && setUnfiled(0));
    return () => {
      live = false;
    };
  }, [clientId, refresh]);

  // Load which of the last 8 quarters have data — ONCE per client. Kept
  // separate from period selection so picking a quarter doesn't re-fetch (which
  // used to race and snap back to the current quarter).
  useEffect(() => {
    let live = true;
    api
      .periods(clientId)
      .then(({ periods: list }) => {
        if (!live) return;
        setPeriodList(list);
        setPeriods(list.map((p) => ({ value: p.period, label: p.hasSnapshot ? p.period : `${p.period} — no data` })));
      })
      .catch(() => {
        if (!live) return;
        const options = lastPeriods('2026-Q1', 4);
        setPeriodList(options.map((p) => ({ period: p, hasSnapshot: false })));
        setPeriods(options.map((p) => ({ value: p, label: p })));
      });
    return () => {
      live = false;
    };
  }, [clientId]);

  // Choose the active quarter off the loaded list (synchronous — no refetch):
  // the URL's ?period= wins when it's in range (refresh persistence +
  // notification deep links); otherwise land on the newest quarter with data,
  // or the NEXT quarter when that one is already completed/archived.
  useEffect(() => {
    if (periodList.length === 0) return;
    if (wantedPeriod && periodList.some((p) => p.period === wantedPeriod)) {
      setPeriod(wantedPeriod);
      return;
    }
    let chosen: string | undefined;
    const newestWithData = periodList.find((p) => p.hasSnapshot);
    const done = newestWithData?.status === 'completed' || newestWithData?.status === 'archived';
    if (newestWithData && done) {
      const idx = periodList.findIndex((p) => p.period === newestWithData.period);
      chosen = (periodList[Math.max(0, idx - 1)] ?? newestWithData).period;
    } else if (newestWithData) {
      chosen = newestWithData.period;
    } else if (periodList[0]) {
      chosen = periodList[0].period;
    }
    if (chosen) {
      setPeriod(chosen);
      if (chosen !== wantedPeriod) selectPeriod(chosen);
    }
  }, [periodList, wantedPeriod]);

  useEffect(() => {
    if (!clientId || !period) return;
    let live = true;
    setLoading(true);
    setError(null);
    api
      .getQbr(clientId, period)
      .then((r) => live && setQbr(r))
      .catch((e) => {
        if (!live) return;
        setQbr(null);
        setError(e instanceof Error ? e.message : 'Failed to build QBR');
      })
      .finally(() => live && setLoading(false));
    // Switching client/quarter always reloads the discussion; a plain refresh
    // (Sync, saves elsewhere) must NOT overwrite answers typed mid-meeting.
    if (discKey.current !== `${clientId}/${period}`) {
      discKey.current = `${clientId}/${period}`;
      discDirty.current = false;
    }
    api
      .getDiscussion(clientId, period)
      .then((d) => live && !discDirty.current && setDisc(d))
      .catch(() => live && !discDirty.current && setDisc({ clientId, period, items: [] }));
    return () => {
      live = false;
    };
  }, [clientId, period, refresh]);

  async function onSync() {
    setSyncing(true);
    try {
      const r = await api.sync(clientId, period);
      notifications.show({
        color: r.warnings.length ? 'yellow' : 'teal',
        title: `Synced ${r.metrics} metric(s)${r.documents ? ` + ${r.documents} vendor report(s)` : ''}`,
        message: r.warnings[0] ?? 'Live data pulled from the connected tools.',
      });
      setRefresh((n) => n + 1);
    } catch (e) {
      toastError('Sync failed', e);
    } finally {
      setSyncing(false);
    }
  }

  const urls = reportUrls(clientId, period);
  const meta = qbr?.meta;

  return (
    <Stack gap="lg">
      <WorkspaceHeader
        name={client?.name ?? qbr?.model.client.name ?? clientId}
        qbr={qbr}
        periods={periods}
        period={period}
        onPeriodChange={(v) => {
          setPeriod(v);
          selectPeriod(v); // remember it across refreshes
        }}
        syncing={syncing}
        onSync={onSync}
        urls={urls}
      />

      {error && <Alert color="red" title="Could not build report">{error}. Try running a Sync, or check the client's tool mappings.</Alert>}
      {configRes.error && (
        <Alert color="red" title="Could not load report settings">
          {configRes.error}. The Data and Studio tabs stay unavailable until the settings load; reload the page to retry.
        </Alert>
      )}

      <Tabs
        value={tab}
        keepMounted={false}
        onChange={(v) => {
          if (!v) return;
          if (tab === 'data' && dataDirty.current && !window.confirm('You have unsaved data-review changes. Leave the Data tab and discard them?')) {
            return;
          }
          if (tab === 'data') dataDirty.current = false;
          setTab(v);
        }}
      >
        <Tabs.List mb="md">
          <Tabs.Tab value="overview">Overview</Tabs.Tab>
          <Tabs.Tab value="data">Data</Tabs.Tab>
          <Tabs.Tab
            value="reports"
            rightSection={
              unfiled > 0 ? (
                <Tooltip label={`${unfiled} report(s) need filing — categorize or AI-match them`}>
                  <Badge size="xs" circle color="yellow" variant="filled">
                    {unfiled}
                  </Badge>
                </Tooltip>
              ) : undefined
            }
          >
            Reports
          </Tabs.Tab>
          <Tabs.Tab value="meeting">Meeting</Tabs.Tab>
          <Tabs.Tab value="actions">Actions</Tabs.Tab>
          <Tabs.Tab value="board">Opportunities</Tabs.Tab>
          <Tabs.Tab value="studio">Studio</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="overview">
          {loading || !period ? (
            <Center h={240}><Loader /></Center>
          ) : (
            <Stack gap="lg">
              <PipelineStepper
                hasData={Boolean(qbr)}
                meta={meta}
                unfiled={unfiled}
                disc={disc}
                goTab={setTab}
                onComplete={async () => {
                  try {
                    await api.putStatus(clientId, period, 'completed');
                    notifications.show({ color: 'teal', message: `${period} QBR completed — the workspace will target the next quarter from now on.` });
                    setRefresh((n) => n + 1);
                  } catch (e) {
                    notifications.show({ color: 'red', message: e instanceof Error ? e.message : 'Could not complete' });
                  }
                }}
                onSkipMeeting={async (reason) => {
                  try {
                    await api.dispositionSkipped(clientId, period, reason || undefined);
                    notifications.show({ color: 'teal', message: `${period} QBR dispositioned — meeting skipped, quarter closed as completed.` });
                    setRefresh((n) => n + 1);
                  } catch (e) {
                    notifications.show({ color: 'red', message: e instanceof Error ? e.message : 'Could not disposition' });
                  }
                }}
              />
              {qbr ? (
                <OverviewTab
                  qbr={qbr}
                  clientId={clientId}
                  period={period}
                  refresh={refresh}
                  aiEnabled={system?.ai ?? false}
                  config={config}
                  setConfig={setConfig}
                  onChanged={() => setRefresh((n) => n + 1)}
                />
              ) : (
                <Text c="dimmed">No report yet — run a Sync to pull this quarter's data.</Text>
              )}
            </Stack>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="data">
          {period && config && (
            <Stack gap="lg" maw={900}>
              <DataTab
                clientId={clientId}
                period={period}
                config={config}
                setConfig={setConfig}
                refresh={refresh}
                onDirty={(d) => (dataDirty.current = d)}
                onSaved={() => setRefresh((n) => n + 1)}
              />
            </Stack>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="reports">
          {period && (
            <ReportsTab
              clientId={clientId}
              period={period}
              periods={periods}
              refresh={refresh}
              reportsMailbox={system?.reportsMailbox ?? null}
              aiEnabled={system?.ai ?? false}
              onChanged={() => setRefresh((n) => n + 1)}
            />
          )}
        </Tabs.Panel>

        <Tabs.Panel value="meeting">
          {disc && (
            <MeetingTab
              disc={disc}
              setDisc={(d) => {
                discDirty.current = true;
                setDisc(d);
              }}
              clientId={clientId}
              period={period}
              meta={meta}
              onSavedDiscussion={() => (discDirty.current = false)}
              onChanged={() => setRefresh((n) => n + 1)}
            />
          )}
        </Tabs.Panel>

        <Tabs.Panel value="actions">
          <ActionsTab clientId={clientId} period={period} disc={disc} onChanged={() => setRefresh((n) => n + 1)} />
        </Tabs.Panel>

        <Tabs.Panel value="board">
          <OpportunitiesTab clientId={clientId} period={period} />
        </Tabs.Panel>

        <Tabs.Panel value="studio">
          {config && <StudioTab config={config} setConfig={setConfig} clientId={clientId} onSaved={() => setRefresh((n) => n + 1)} />}
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
