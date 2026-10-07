import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Tabs, Text, Stack, Alert, Loader, Center, Badge, Tooltip, Button, Group } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { api, ApiError, reportUrls } from '../api.js';
import { lastPeriods } from '../periods.js';
import type { Client, Discussion, PackageStage, QbrResponse, SystemInfo } from '../types.js';
import { useResource } from '../hooks/useResource.js';
import { toastError, toastOk } from '../toast.js';
import { WorkspaceHeader } from './workspace/WorkspaceHeader.js';
import { FinalizeConfirm, PipelineStepper } from './workspace/PipelineStepper.js';
import { OverviewTab } from './workspace/OverviewTab.js';
import { DataTab } from './workspace/DataTab.js';
import { ReportsTab } from './workspace/ReportsTab.js';
import { MeetingTab } from './workspace/MeetingTab.js';
import { ActionsTab } from './workspace/ActionsTab.js';
import { OpportunitiesTab } from './workspace/OpportunitiesTab.js';
import { StudioTab } from './workspace/StudioTab.js';
import { BudgetTab } from './workspace/BudgetTab.js';
import { deliverableGuard, deriveSteps, lockNotice, primaryStep, type Step } from './workspace/nextStep.js';
import { chooseLandingPeriod, lockedPeriodNotices, metaFromPeriodList, nextPeriodIn, qbrLoadError, type LandingPeriod } from './workspace/landing.js';

/** The quarter the calendar is in right now, e.g. 2026-Q4 (UTC, same as the API). */
function currentQuarterId(d = new Date()): string {
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/**
 * The QBR workspace, organized around the working flow: the header carries
 * the next step and the deliverables; the tabs follow the lifecycle:
 * Overview (what the client sees), Data (what feeds it), Reports (what was
 * filed), Meeting (prep and run the review), Actions (what happens after),
 * Opportunities, Studio (shape the report).
 */
export function Workspace() {
  const { clientId = '' } = useParams();
  // The selected quarter lives in the URL (?period=) so a browser refresh
  // stays on the quarter you were viewing instead of jumping to the current
  // one, and a notification deep link re-runs the targeting effect even when
  // we're already on this client.
  const [searchParams, setSearchParams] = useSearchParams();
  const wantedPeriod = searchParams.get('period');
  const selectPeriod = (p: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('period', p);
    setSearchParams(next, { replace: true });
  };
  const [periods, setPeriods] = useState<Array<{ value: string; label: string }>>([]);
  const [periodList, setPeriodList] = useState<LandingPeriod[]>([]);
  const [periodsError, setPeriodsError] = useState<string | null>(null);
  const [period, setPeriod] = useState('');
  const [qbr, setQbr] = useState<QbrResponse | null>(null);
  // Report settings: a failed load stays an error (no `{ clientId }` stand-in
  // that a later Save would write over the real settings).
  const configRes = useResource(() => api.getConfig(clientId), [clientId]);
  const config = configRes.data ?? null;
  const setConfig = configRes.setData;
  const [disc, setDisc] = useState<Discussion | null>(null);
  const [discError, setDiscError] = useState<string | null>(null);
  const [client, setClient] = useState<Client | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState<{ title: string; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [primaryBusy, setPrimaryBusy] = useState(false);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [tab, setTab] = useState<string>('overview');
  // Unsaved-work guards: a refresh must not clobber a mid-meeting agenda, and
  // leaving the Data tab with staged review changes should ask first.
  const discDirty = useRef(false);
  const dataDirty = useRef(false);
  const discKey = useRef('');

  useEffect(() => {
    // Switching clients: clear every piece of the previous client's state,
    // including the quarter, so nothing fetches (or bills an AI draft for)
    // the old quarter under the new client.
    let live = true;
    setClient(null);
    setQbr(null);
    setDisc(null);
    setDiscError(null);
    setError(null);
    setPeriod('');
    setPeriodList([]);
    setPeriods([]);
    api
      .listClients()
      .then((d) => live && setClient(d.clients.find((c) => c.id === clientId) ?? null))
      .catch(() => {});
    api
      .system()
      .then((s) => live && setSystem(s))
      .catch((e) => live && e instanceof ApiError && e.status === 401 && setSignedOut(true));
    return () => {
      live = false;
    };
  }, [clientId]);

  // Reports needing attention: uncategorized files (fresh inbox arrivals land
  // without a category until matched/filed); surfaces a count on the tab.
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

  // Load which of the last 8 quarters have data, once per client. Kept
  // separate from period selection so picking a quarter doesn't re-fetch.
  useEffect(() => {
    let live = true;
    setPeriodsError(null);
    api
      .periods(clientId)
      .then(({ periods: list }) => {
        if (!live) return;
        setPeriodList(list);
        setPeriods(list.map((p) => ({ value: p.period, label: p.hasSnapshot ? p.period : `${p.period} (no data)` })));
      })
      .catch((e) => {
        if (!live) return;
        // Fall back to the calendar, not a hard-coded quarter, and say so.
        const options = lastPeriods(currentQuarterId(), 4);
        setPeriodList(options.map((p) => ({ period: p, hasSnapshot: false })));
        setPeriods(options.map((p) => ({ value: p, label: p })));
        setPeriodsError(e instanceof Error ? e.message : 'Could not load this client’s quarters');
      });
    return () => {
      live = false;
    };
  }, [clientId]);

  // Choose the active quarter off the loaded list (synchronous, no refetch):
  // the URL's ?period= wins when it's in range; otherwise the open quarter,
  // else the newest final one (read-only). The URL is rewritten to carry it.
  useEffect(() => {
    if (periodList.length === 0) return;
    const chosen = chooseLandingPeriod(periodList, wantedPeriod);
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
        // A quarter with no snapshot is an empty state, not an error; a
        // locked quarter with a missing package says to reopen it.
        setError(qbrLoadError(e instanceof ApiError ? e.status : undefined, e instanceof Error ? e.message : 'Failed to build QBR'));
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
      .then((d) => {
        if (!live || discDirty.current) return;
        setDisc(d);
        setDiscError(null);
      })
      .catch((e) => {
        if (!live || discDirty.current) return;
        // Keep the error: an empty stand-in would let Save wipe the real agenda.
        setDisc(null);
        setDiscError(e instanceof Error ? e.message : 'Could not load the agenda');
      });
    return () => {
      live = false;
    };
  }, [clientId, period, refresh]);

  async function onSync() {
    setSyncing(true);
    try {
      const r = await api.sync(clientId, period);
      const extra = r.warnings.length > 1 ? ` and ${r.warnings.length - 1} more note${r.warnings.length > 2 ? 's' : ''} on the Data tab` : '';
      toastOk(`Synced ${r.metrics} metrics${r.documents ? ` and ${r.documents} vendor reports` : ''}.${r.warnings[0] ? ` ${r.warnings[0]}${extra}` : ''}`);
      setRefresh((n) => n + 1);
    } catch (e) {
      toastError('Sync failed', e);
    } finally {
      setSyncing(false);
    }
  }

  /** Lock 2 on demand: the final package is stored and the quarter goes read-only. */
  async function onFinalize() {
    try {
      const saved = await api.finalize(clientId, period);
      toastOk(`${period} finalized. The final package is stored and the quarter is read-only.`);
      setPeriodList((list) => list.map((p) => (p.period === period ? { ...p, status: saved.status, locks: saved.locks } : p)));
      setRefresh((n) => n + 1);
    } catch (e) {
      toastError('Could not finalize the quarter', e);
      throw e;
    }
  }

  async function onReopen(stage: PackageStage, reason: string) {
    try {
      const saved = await api.reopen(clientId, period, { stage, reason });
      toastOk(stage === 'final' ? `${period} reopened. The agenda and decisions can change again.` : `${period} reopened. Data, narrative and agenda can change again.`);
      setPeriodList((list) => list.map((p) => (p.period === period ? { ...p, status: saved.status, locks: saved.locks } : p)));
      setRefresh((n) => n + 1);
    } catch (e) {
      toastError('Could not reopen the quarter', e);
      throw e;
    }
  }

  async function onApprove() {
    setPrimaryBusy(true);
    try {
      await api.approveNarrative(clientId, period);
      toastOk('Narrative approved.');
      setRefresh((n) => n + 1);
    } catch (e) {
      toastError('Approve failed', e);
    } finally {
      setPrimaryBusy(false);
    }
  }

  /** The header's one primary button: do the next step, or go where it happens. */
  function onPrimary(step: Step) {
    switch (step.key) {
      case 'sync':
        void onSync();
        return;
      case 'narrative':
        if (qbr && qbr.verification) void onApprove();
        else setTab('overview');
        return;
      case 'finalize':
        setConfirmFinalize(true);
        return;
      default:
        setTab(step.tab);
    }
  }

  const urls = reportUrls(clientId, period);
  // When the QBR fails to load (a locked quarter whose package is missing),
  // the lock state still comes from the period list so Reopen stays available.
  const meta = qbr?.meta ?? metaFromPeriodList(periodList, clientId, period);
  const steps = deriveSteps({ hasData: Boolean(qbr), meta, unfiled, disc });
  const next = primaryStep(steps, meta);
  const notice = lockNotice(meta);
  const finalized = Boolean(meta?.locks?.final);
  // Lock sentence per quarter for the Reports tab (it spans every quarter);
  // the selected quarter follows its freshly loaded record.
  const lockedPeriods = lockedPeriodNotices(periodList, clientId);
  if (notice) lockedPeriods[period] = notice;
  else if (qbr?.meta) delete lockedPeriods[period];
  const nextQuarter = finalized ? nextPeriodIn(periodList, period) : undefined;
  const guard = deliverableGuard({
    hasQbr: Boolean(qbr),
    verificationOk: qbr?.verification ?? false,
    status: meta?.status,
    confidence: qbr?.model.scorecard.overall.confidence,
    locked: Boolean(notice),
  });

  return (
    <Stack gap="lg">
      <WorkspaceHeader
        name={client?.name ?? qbr?.model.client.name ?? clientId}
        qbr={qbr}
        meta={meta}
        periods={periods}
        period={period}
        onPeriodChange={(v) => {
          setPeriod(v);
          selectPeriod(v);
        }}
        syncing={syncing}
        onSync={onSync}
        urls={urls}
        clientId={clientId}
        next={next}
        guard={guard}
        primaryBusy={primaryBusy}
        onPrimary={onPrimary}
        onPackageSent={() => setRefresh((n) => n + 1)}
        lockNotice={notice}
        onReopen={onReopen}
      />
      <FinalizeConfirm opened={confirmFinalize} period={period} onClose={() => setConfirmFinalize(false)} onFinalize={onFinalize} />

      {notice && (
        <Alert color={finalized ? 'good' : 'navy'} variant="light" icon={<IconLock size={18} />}>
          <Group justify="space-between" gap="sm" wrap="wrap">
            <Text size="sm">{notice}</Text>
            {nextQuarter && (
              <Button
                size="compact-sm"
                variant="light"
                onClick={() => {
                  setPeriod(nextQuarter);
                  selectPeriod(nextQuarter);
                }}
              >
                Start next quarter
              </Button>
            )}
          </Group>
        </Alert>
      )}

      {signedOut && (
        <Alert color="act" title="Your session has expired">
          <Group gap="sm">
            <Text size="sm">Sign in again to keep working.</Text>
            <Button size="compact-sm" component="a" href="/.auth/login/aad?post_login_redirect_uri=/">Sign in</Button>
          </Group>
        </Alert>
      )}
      {error && <Alert color="act" title={error.title}>{error.text}</Alert>}
      {periodsError && (
        <Alert color="watch" title="Quarter list unavailable">
          {periodsError}. Showing the last four calendar quarters without data markers.
        </Alert>
      )}
      {configRes.error && (
        <Alert color="act" title="Could not load report settings">
          <Group gap="sm">
            <Text size="sm">{configRes.error}. The Data and Studio tabs and the narrative direction stay read-only until the settings load.</Text>
            <Button size="compact-sm" variant="light" onClick={configRes.reload}>Retry</Button>
          </Group>
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
                <Tooltip label={`${unfiled} report${unfiled === 1 ? '' : 's'} need filing: categorize or AI-match them`}>
                  <Badge size="xs" circle color="watch" variant="filled">
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
          <Tabs.Tab value="budget">Budget</Tabs.Tab>
          <Tabs.Tab value="studio">Studio</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="overview">
          {loading || !period ? (
            <Center h={240}>
              <Loader />
            </Center>
          ) : (
            <Stack gap="lg">
              <PipelineStepper
                steps={steps}
                next={next}
                skipped={Boolean(meta?.meetingSkipped)}
                packageSent={Boolean(meta?.packageSentAt)}
                period={period}
                goTab={setTab}
                finalizeDue={next?.key === 'finalize'}
                onFinalize={onFinalize}
                onSkipMeeting={async (reason) => {
                  try {
                    await api.dispositionSkipped(clientId, period, reason || undefined);
                    toastOk(`${period} closed without a meeting.`);
                    setRefresh((n) => n + 1);
                  } catch (e) {
                    toastError('Could not close the quarter', e);
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
                  configError={configRes.error}
                  setConfig={setConfig}
                  onChanged={() => setRefresh((n) => n + 1)}
                />
              ) : (
                <Alert color="slate" variant="light" title={`No data for ${period} yet`}>
                  <Group gap="sm">
                    <Text size="sm">Pull this quarter's data from the connected tools to start the review.</Text>
                    <Button size="compact-sm" loading={syncing} onClick={onSync}>Sync data</Button>
                  </Group>
                </Alert>
              )}
            </Stack>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="data">
          {period && config ? (
            <Stack gap="lg" maw={900}>
              <DataTab
                clientId={clientId}
                period={period}
                config={config}
                setConfig={setConfig}
                refresh={refresh}
                lastSyncAttempt={meta?.lastSyncAttempt}
                lockNotice={notice}
                onDirty={(d) => (dataDirty.current = d)}
                onSaved={() => setRefresh((n) => n + 1)}
              />
            </Stack>
          ) : (
            period && !configRes.error && <Center h={160}><Loader /></Center>
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
              lockedPeriods={lockedPeriods}
              onChanged={() => setRefresh((n) => n + 1)}
            />
          )}
        </Tabs.Panel>

        <Tabs.Panel value="meeting">
          {discError ? (
            <Alert color="act" title="Could not load the agenda">
              <Group gap="sm">
                <Text size="sm">{discError}. Nothing can be saved until it loads, so last quarter's answers stay safe.</Text>
                <Button size="compact-sm" variant="light" onClick={() => setRefresh((n) => n + 1)}>Retry</Button>
              </Group>
            </Alert>
          ) : disc ? (
            <MeetingTab
              disc={disc}
              setDisc={(d) => {
                discDirty.current = true;
                setDisc(d);
              }}
              clientId={clientId}
              period={period}
              meta={meta}
              hipaa={client?.hipaa === true}
              onSavedDiscussion={() => (discDirty.current = false)}
              onChanged={() => setRefresh((n) => n + 1)}
            />
          ) : (
            <Center h={160}><Loader /></Center>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="actions">
          <ActionsTab clientId={clientId} period={period} disc={disc} onChanged={() => setRefresh((n) => n + 1)} />
        </Tabs.Panel>

        <Tabs.Panel value="board">
          <OpportunitiesTab clientId={clientId} period={period} />
        </Tabs.Panel>

        <Tabs.Panel value="budget">
          <BudgetTab clientId={clientId} period={period} onPublished={() => setRefresh((n) => n + 1)} />
        </Tabs.Panel>

        <Tabs.Panel value="studio">
          {config ? (
            <StudioTab config={config} setConfig={setConfig} clientId={clientId} onSaved={() => setRefresh((n) => n + 1)} />
          ) : (
            !configRes.error && <Center h={160}><Loader /></Center>
          )}
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
