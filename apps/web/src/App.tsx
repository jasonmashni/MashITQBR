import { useEffect, useState } from 'react';

interface Client { id: string; name: string; industry?: string; hipaa?: boolean }
interface FunctionScore { function: string; score: number | null; rating: string }
interface QbrResponse {
  model: {
    client: { name: string };
    period: { label: string };
    brand?: { name?: string; logoDataUri?: string };
    executive: { headline?: string; paragraphs: string[]; highlights: string[] };
    scorecard: { overall: { score: number | null; rating: string }; functions: FunctionScore[] };
    recommendations: string[];
  };
  warnings: string[];
  verification: boolean;
}

interface Brand { name?: string; logoDataUri?: string; primary?: string; accent?: string }
interface CustomSection { id: string; title: string; body: string; placement?: string }
interface ReportConfig { clientId: string; hiddenSections?: string[]; customSections?: CustomSection[]; brand?: Brand }
interface DiscussionItem { id: string; topic: string; response?: string; disposition?: string; owner?: string }
interface Discussion { clientId: string; period: string; items: DiscussionItem[]; notes?: string }

const PERIODS = ['2026-Q1', '2025-Q4'];
const SECTIONS: Array<[string, string]> = [
  ['operations', 'Operational Stability & Support'],
  ['security', 'Security & Risk'],
  ['identity', 'Identity & Access'],
  ['backup', 'Backup & Recovery'],
  ['infrastructure', 'Infrastructure & Refresh'],
  ['spend', 'IT Spend'],
];
const DISPOSITIONS = ['pending', 'create_opportunity', 'create_ticket', 'accept_risk', 'no_action'];
const ratingColor: Record<string, string> = { green: '#2e7d32', amber: '#ed9c28', red: '#c62828', unknown: '#9e9e9e' };
const uid = () => Math.random().toString(36).slice(2, 9);

export function App() {
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState('');
  const [period, setPeriod] = useState(PERIODS[0]!);
  const [tab, setTab] = useState<'report' | 'customize' | 'discussion'>('report');
  const [qbr, setQbr] = useState<QbrResponse | null>(null);
  const [config, setConfig] = useState<ReportConfig | null>(null);
  const [disc, setDisc] = useState<Discussion | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/clients').then((r) => r.json()).then((d: { clients: Client[] }) => {
      setClients(d.clients);
      if (d.clients[0]) setClientId(d.clients[0].id);
    }).catch(() => setError('Could not load clients. Is the API running?'));
  }, []);

  useEffect(() => {
    if (!clientId) return;
    fetch(`/api/clients/${clientId}/config`).then((r) => r.json()).then(setConfig).catch(() => setConfig({ clientId }));
  }, [clientId]);

  useEffect(() => {
    if (!clientId) return;
    setError(null);
    fetch(`/api/clients/${clientId}/qbr/${period}`)
      .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(e))))
      .then(setQbr).catch((e) => setError(e?.error ?? 'Failed to build QBR'));
    fetch(`/api/clients/${clientId}/qbr/${period}/discussion`).then((r) => r.json()).then(setDisc)
      .catch(() => setDisc({ clientId, period, items: [] }));
  }, [clientId, period, refresh]);

  const base = clientId ? `/api/clients/${clientId}/qbr/${period}` : '';

  async function saveConfig() {
    if (!config) return;
    await fetch(`/api/clients/${clientId}/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
    setRefresh((n) => n + 1);
    setTab('report');
  }
  async function saveDiscussion() {
    if (!disc) return;
    await fetch(`/api/clients/${clientId}/qbr/${period}/discussion`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(disc) });
    setRefresh((n) => n + 1);
    setTab('report');
  }

  function onLogo(file: File) {
    const reader = new FileReader();
    reader.onload = () => setConfig((c) => ({ ...(c ?? { clientId }), brand: { ...(c?.brand ?? {}), logoDataUri: String(reader.result) } }));
    reader.readAsDataURL(file);
  }

  const brand = config?.brand ?? qbr?.model.brand ?? {};
  const tabBtn = (id: typeof tab, label: string) => (
    <button onClick={() => setTab(id)} style={{ padding: '6px 14px', border: 'none', borderBottom: tab === id ? '3px solid #1d7874' : '3px solid transparent', background: 'none', fontWeight: tab === id ? 700 : 400, cursor: 'pointer', color: tab === id ? '#0b2545' : '#555' }}>{label}</button>
  );

  return (
    <div style={{ fontFamily: 'Segoe UI, system-ui, sans-serif', color: '#1a1a1a', maxWidth: 1100, margin: '0 auto', padding: 24 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, borderBottom: '2px solid #1d7874', paddingBottom: 8 }}>
        {brand.logoDataUri ? <img src={brand.logoDataUri} alt="logo" style={{ maxHeight: 40 }} /> : null}
        <h1 style={{ color: '#0b2545', margin: 0 }}>{brand.name ?? 'Mash IT'} QBR</h1>
      </header>

      <div style={{ display: 'flex', gap: 12, margin: '16px 0' }}>
        <label>Client{' '}
          <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>Quarter{' '}
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      </div>

      <nav style={{ borderBottom: '1px solid #ddd', marginBottom: 16 }}>
        {tabBtn('report', 'Report')}
        {tabBtn('customize', 'Branding & Sections')}
        {tabBtn('discussion', 'Discussion & Responses')}
      </nav>

      {error && <p style={{ color: '#c62828' }}>{error}</p>}

      {tab === 'report' && qbr && (
        <>
          {qbr.warnings.length > 0 && (
            <div style={{ background: '#fff6e5', border: '1px solid #ed9c28', borderRadius: 6, padding: 10, margin: '8px 0' }}>
              {qbr.warnings.map((w, i) => <div key={i}>⚠️ {w}</div>)}
            </div>
          )}
          <h2 style={{ color: '#0b2545' }}>{qbr.model.client.name} — {qbr.model.period.label}</h2>
          {qbr.model.executive.headline && <p style={{ fontWeight: 600, color: '#0b2545' }}>{qbr.model.executive.headline}</p>}
          <div style={{ margin: '12px 0' }}>
            <strong>Security maturity: </strong>
            <span style={{ background: ratingColor[qbr.model.scorecard.overall.rating] ?? '#9e9e9e', color: '#fff', padding: '2px 10px', borderRadius: 12, fontWeight: 600 }}>
              {qbr.model.scorecard.overall.score ?? '—'} / 100 · {qbr.model.scorecard.overall.rating}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 12, margin: '16px 0' }}>
            <a href={`${base}/report.html`} target="_blank" rel="noreferrer">Open report</a>
            <a href={`${base}/report.pdf`} target="_blank" rel="noreferrer">Download PDF</a>
            <a href={`${base}/deck.pptx`}>Download deck</a>
          </div>
          <iframe title="QBR report" src={`${base}/report.html?v=${refresh}`} style={{ width: '100%', height: 600, border: '1px solid #ddd', borderRadius: 6 }} />
        </>
      )}

      {tab === 'customize' && config && (
        <div>
          <h3>Branding</h3>
          <label>Company name{' '}
            <input value={config.brand?.name ?? ''} onChange={(e) => setConfig({ ...config, brand: { ...config.brand, name: e.target.value } })} />
          </label>
          <div style={{ margin: '8px 0' }}>
            <label>Primary color{' '}
              <input type="color" value={config.brand?.primary ?? '#0b2545'} onChange={(e) => setConfig({ ...config, brand: { ...config.brand, primary: e.target.value } })} />
            </label>{'  '}
            <label>Accent{' '}
              <input type="color" value={config.brand?.accent ?? '#1d7874'} onChange={(e) => setConfig({ ...config, brand: { ...config.brand, accent: e.target.value } })} />
            </label>
          </div>
          <div style={{ margin: '8px 0' }}>
            <label>Logo{' '}<input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && onLogo(e.target.files[0])} /></label>
            {config.brand?.logoDataUri && <img src={config.brand.logoDataUri} alt="logo preview" style={{ maxHeight: 40, marginLeft: 8, verticalAlign: 'middle' }} />}
          </div>

          <h3>Sections</h3>
          {SECTIONS.map(([key, label]) => {
            const hidden = config.hiddenSections?.includes(key) ?? false;
            return (
              <label key={key} style={{ display: 'block' }}>
                <input type="checkbox" checked={!hidden} onChange={(e) => {
                  const set = new Set(config.hiddenSections ?? []);
                  if (e.target.checked) set.delete(key); else set.add(key);
                  setConfig({ ...config, hiddenSections: [...set] });
                }} /> {label}
              </label>
            );
          })}

          <h3>Custom sections</h3>
          {(config.customSections ?? []).map((s, i) => (
            <div key={s.id} style={{ border: '1px solid #ddd', borderRadius: 6, padding: 8, margin: '6px 0' }}>
              <input placeholder="Title" value={s.title} style={{ width: '60%' }} onChange={(e) => {
                const cs = [...(config.customSections ?? [])]; cs[i] = { ...s, title: e.target.value }; setConfig({ ...config, customSections: cs });
              }} />{' '}
              <select value={s.placement ?? 'in-body'} onChange={(e) => { const cs = [...(config.customSections ?? [])]; cs[i] = { ...s, placement: e.target.value }; setConfig({ ...config, customSections: cs }); }}>
                <option value="after-summary">After summary</option>
                <option value="in-body">In body</option>
                <option value="end">At end</option>
              </select>{' '}
              <button onClick={() => setConfig({ ...config, customSections: (config.customSections ?? []).filter((x) => x.id !== s.id) })}>Remove</button>
              <textarea placeholder="Body" value={s.body} style={{ width: '100%', height: 60, marginTop: 6 }} onChange={(e) => { const cs = [...(config.customSections ?? [])]; cs[i] = { ...s, body: e.target.value }; setConfig({ ...config, customSections: cs }); }} />
            </div>
          ))}
          <button onClick={() => setConfig({ ...config, customSections: [...(config.customSections ?? []), { id: uid(), title: '', body: '', placement: 'in-body' }] })}>+ Add section</button>

          <div style={{ marginTop: 16 }}>
            <button onClick={saveConfig} style={{ background: '#1d7874', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 6, cursor: 'pointer' }}>Save & regenerate</button>
          </div>
        </div>
      )}

      {tab === 'discussion' && disc && (
        <div>
          <h3>Discussion & responses</h3>
          <p style={{ color: '#555' }}>Capture talking points, client responses, and dispositions live during the review.</p>
          {disc.items.map((it, i) => (
            <div key={it.id} style={{ border: '1px solid #ddd', borderRadius: 6, padding: 8, margin: '6px 0' }}>
              <input placeholder="Topic / question / decision" value={it.topic} style={{ width: '100%' }} onChange={(e) => { const items = [...disc.items]; items[i] = { ...it, topic: e.target.value }; setDisc({ ...disc, items }); }} />
              <textarea placeholder="Client response & notes" value={it.response ?? ''} style={{ width: '100%', height: 50, marginTop: 6 }} onChange={(e) => { const items = [...disc.items]; items[i] = { ...it, response: e.target.value }; setDisc({ ...disc, items }); }} />
              <div style={{ marginTop: 6 }}>
                <select value={it.disposition ?? 'pending'} onChange={(e) => { const items = [...disc.items]; items[i] = { ...it, disposition: e.target.value }; setDisc({ ...disc, items }); }}>
                  {DISPOSITIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>{' '}
                <input placeholder="Owner" value={it.owner ?? ''} onChange={(e) => { const items = [...disc.items]; items[i] = { ...it, owner: e.target.value }; setDisc({ ...disc, items }); }} />{' '}
                <button onClick={() => setDisc({ ...disc, items: disc.items.filter((x) => x.id !== it.id) })}>Remove</button>
              </div>
            </div>
          ))}
          <button onClick={() => setDisc({ ...disc, items: [...disc.items, { id: uid(), topic: '', response: '', disposition: 'pending' }] })}>+ Add item</button>

          <h3>General notes</h3>
          <textarea value={disc.notes ?? ''} style={{ width: '100%', height: 80 }} onChange={(e) => setDisc({ ...disc, notes: e.target.value })} />

          <div style={{ marginTop: 16 }}>
            <button onClick={saveDiscussion} style={{ background: '#1d7874', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 6, cursor: 'pointer' }}>Save & regenerate</button>
          </div>
        </div>
      )}
    </div>
  );
}
