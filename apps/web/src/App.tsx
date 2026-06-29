import { useEffect, useState } from 'react';

interface Client {
  id: string;
  name: string;
  industry?: string;
  hipaa?: boolean;
}

interface FunctionScore {
  function: string;
  score: number | null;
  rating: string;
}

interface QbrResponse {
  model: {
    client: { name: string };
    period: { label: string };
    executive: { headline?: string; paragraphs: string[]; highlights: string[] };
    scorecard: { overall: { score: number | null; rating: string }; functions: FunctionScore[] };
    recommendations: string[];
  };
  warnings: string[];
  verification: boolean;
}

const PERIODS = ['2026-Q1', '2025-Q4'];
const ratingColor: Record<string, string> = {
  green: '#2e7d32',
  amber: '#ed9c28',
  red: '#c62828',
  unknown: '#9e9e9e',
};

export function App() {
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState<string>('');
  const [period, setPeriod] = useState<string>(PERIODS[0]!);
  const [qbr, setQbr] = useState<QbrResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/clients')
      .then((r) => r.json())
      .then((d: { clients: Client[] }) => {
        setClients(d.clients);
        if (d.clients[0]) setClientId(d.clients[0].id);
      })
      .catch(() => setError('Could not load clients. Is the API running?'));
  }, []);

  useEffect(() => {
    if (!clientId) return;
    setLoading(true);
    setError(null);
    fetch(`/api/clients/${clientId}/qbr/${period}`)
      .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(e))))
      .then((d: QbrResponse) => setQbr(d))
      .catch((e) => setError(e?.error ?? 'Failed to build QBR'))
      .finally(() => setLoading(false));
  }, [clientId, period]);

  const base = clientId ? `/api/clients/${clientId}/qbr/${period}` : '';

  return (
    <div style={{ fontFamily: 'Segoe UI, system-ui, sans-serif', color: '#1a1a1a', maxWidth: 1100, margin: '0 auto', padding: 24 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, borderBottom: '2px solid #1d7874', paddingBottom: 8 }}>
        <h1 style={{ color: '#0b2545', margin: 0 }}>Mash IT QBR</h1>
        <span style={{ color: '#1d7874', fontWeight: 600 }}>Quarterly Business Reviews</span>
      </header>

      <div style={{ display: 'flex', gap: 12, margin: '16px 0' }}>
        <label>
          Client{' '}
          <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Quarter{' '}
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            {PERIODS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p style={{ color: '#c62828' }}>{error}</p>}
      {loading && <p>Building QBR…</p>}

      {qbr && !loading && (
        <>
          {qbr.warnings.length > 0 && (
            <div style={{ background: '#fff6e5', border: '1px solid #ed9c28', borderRadius: 6, padding: 10, margin: '8px 0' }}>
              {qbr.warnings.map((w, i) => (
                <div key={i}>⚠️ {w}</div>
              ))}
            </div>
          )}

          <h2 style={{ color: '#0b2545' }}>{qbr.model.client.name} — {qbr.model.period.label}</h2>
          {qbr.model.executive.headline && <p style={{ fontWeight: 600, color: '#0b2545' }}>{qbr.model.executive.headline}</p>}

          <div style={{ margin: '12px 0' }}>
            <strong>Security maturity: </strong>
            <span
              style={{
                background: ratingColor[qbr.model.scorecard.overall.rating] ?? '#9e9e9e',
                color: '#fff',
                padding: '2px 10px',
                borderRadius: 12,
                fontWeight: 600,
              }}
            >
              {qbr.model.scorecard.overall.score ?? '—'} / 100 · {qbr.model.scorecard.overall.rating}
            </span>
          </div>

          {qbr.model.executive.paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}

          <div style={{ display: 'flex', gap: 12, margin: '16px 0' }}>
            <a href={`${base}/report.html`} target="_blank" rel="noreferrer">Open report</a>
            <a href={`${base}/report.pdf`} target="_blank" rel="noreferrer">Download PDF</a>
            <a href={`${base}/deck.pptx`}>Download deck</a>
          </div>

          <iframe title="QBR report" src={`${base}/report.html`} style={{ width: '100%', height: 600, border: '1px solid #ddd', borderRadius: 6 }} />
        </>
      )}
    </div>
  );
}
