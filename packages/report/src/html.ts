import type { FunctionScore, SafeguardResult } from '@mashit/core';
import { abbreviate, formatPercent, formatTrend, formatValue, ratingClass } from './format.js';
import type { ReportModel, ReportSection } from './model.js';

/** Mash IT brand tokens. Centralized so the report theme is swappable. */
export interface BrandTokens {
  name: string;
  primary: string;
  accent: string;
  ink: string;
  bg: string;
  font: string;
}

export const MASH_IT_BRAND: BrandTokens = {
  name: 'Mash IT',
  primary: '#0b2545',
  accent: '#1d7874',
  ink: '#1a1a1a',
  bg: '#ffffff',
  font: "'Segoe UI', system-ui, -apple-system, sans-serif",
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function styles(brand: BrandTokens): string {
  return `
:root{--primary:${brand.primary};--accent:${brand.accent};--ink:${brand.ink};--bg:${brand.bg};}
*{box-sizing:border-box}
body{font-family:${brand.font};color:var(--ink);margin:0;background:var(--bg);font-size:13px;line-height:1.5}
.page{padding:40px 48px;page-break-after:always}
.page:last-child{page-break-after:auto}
h1{color:var(--primary);font-size:30px;margin:0 0 4px}
h2{color:var(--primary);font-size:18px;border-bottom:2px solid var(--accent);padding-bottom:4px;margin:24px 0 12px}
.brandbar{color:var(--accent);font-weight:600;letter-spacing:.04em}
.meta{color:#555;margin:2px 0}
table{width:100%;border-collapse:collapse;margin:8px 0}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e3e3e3}
th{color:#555;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
.num{text-align:right;font-variant-numeric:tabular-nums}
.trend-up{color:#c62828}.trend-down{color:#2e7d32}
.chip{display:inline-block;padding:2px 10px;border-radius:12px;color:#fff;font-weight:600;font-size:12px}
.rating-green{background:#2e7d32}.rating-amber{background:#ed9c28}.rating-red{background:#c62828}.rating-unknown{background:#9e9e9e}
.scorecard{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:12px 0}
.fn{border:1px solid #e3e3e3;border-radius:8px;padding:10px}
.fn .score{font-size:22px;font-weight:700;color:var(--primary)}
.headline{font-size:16px;font-weight:600;color:var(--primary);margin:0 0 8px}
ul{margin:6px 0;padding-left:20px}
@page{size:Letter;margin:14mm}
@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;
}

function renderCover(m: ReportModel): string {
  return `<section class="page">
  <div class="brandbar">${esc(MASH_IT_BRAND.name)}+ &middot; Quarterly Business Review</div>
  <h1>${esc(m.client.name)}</h1>
  <p class="meta"><strong>Period:</strong> ${esc(m.period.label)}</p>
  ${m.client.primaryContact ? `<p class="meta"><strong>Primary contact:</strong> ${esc(m.client.primaryContact)}</p>` : ''}
  ${m.heldBy ? `<p class="meta"><strong>QBR held by:</strong> ${esc(m.heldBy)}</p>` : ''}
  ${m.generatedLabel ? `<p class="meta"><strong>Date:</strong> ${esc(m.generatedLabel)}</p>` : ''}
  ${m.client.hipaa ? `<p class="meta"><em>Contains confidential client information (HIPAA).</em></p>` : ''}
</section>`;
}

function renderExecutive(m: ReportModel): string {
  if (!m.executive.headline && m.executive.paragraphs.length === 0) return '';
  return `<section class="page">
  <h2>Executive Summary</h2>
  ${m.executive.headline ? `<p class="headline">${esc(m.executive.headline)}</p>` : ''}
  ${m.executive.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('\n')}
  ${
    m.executive.highlights.length
      ? `<ul>${m.executive.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`
      : ''
  }
</section>`;
}

function renderScorecard(m: ReportModel): string {
  const s = m.scorecard;
  const overall = s.overall.score === null ? '—' : Math.round(s.overall.score).toString();
  const fnCard = (f: FunctionScore) =>
    `<div class="fn"><div>${esc(f.function)}</div><div class="score">${f.score === null ? '—' : Math.round(f.score)}</div><span class="chip ${ratingClass(f.rating)}">${f.rating}</span></div>`;
  const remediation = (r: SafeguardResult) => `<li><strong>${esc(r.title)}</strong> — ${esc(r.evidence)}</li>`;
  return `<section class="page">
  <h2>Security &amp; Risk Maturity</h2>
  <p>Blended CIS Controls v8 / NIST CSF 2.0 maturity score:
    <span class="chip ${ratingClass(s.overall.rating)}">${overall} / 100 · ${s.overall.rating}</span>
    <span class="meta">(${formatPercent(s.overall.coverage * 100)} of controls measured)</span></p>
  <div class="scorecard">${s.functions.map(fnCard).join('')}</div>
  ${
    s.remediations.length
      ? `<h2>Priority Remediations</h2><ul>${s.remediations.map(remediation).join('')}</ul>`
      : ''
  }
</section>`;
}

function renderSection(section: ReportSection): string {
  const rows = section.rows
    .map(({ metric, trend }) => {
      const t = trend ? formatTrend(trend) : '';
      const cls = trend?.sentiment === 'negative' ? 'trend-up' : trend?.sentiment === 'positive' ? 'trend-down' : '';
      return `<tr><td>${esc(metric.label)}</td><td class="num">${esc(formatValue(metric))}</td><td class="num ${cls}">${esc(t)}</td></tr>`;
    })
    .join('\n');
  return `<h2>${esc(section.title)}</h2>
  <table><thead><tr><th>Metric</th><th class="num">This quarter</th><th class="num">vs last</th></tr></thead>
  <tbody>${rows}</tbody></table>`;
}

function renderBody(m: ReportModel): string {
  if (m.sections.length === 0) return '';
  return `<section class="page">
  ${m.sections.map(renderSection).join('\n')}
  ${
    m.recommendations.length
      ? `<h2>Recommendations &amp; Next 90 Days</h2><ul>${m.recommendations.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`
      : ''
  }
</section>`;
}

/** Render the full branded QBR report as a single self-contained HTML document. */
export function renderReportHtml(model: ReportModel, brand: BrandTokens = MASH_IT_BRAND): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(model.client.name)} — ${esc(model.period.label)} QBR</title>
<style>${styles(brand)}</style></head>
<body>
${renderCover(model)}
${renderExecutive(model)}
${renderScorecard(model)}
${renderBody(model)}
</body></html>`;
}

/** Re-exported for callers that want abbreviated headline numbers. */
export { abbreviate };
