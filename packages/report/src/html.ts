import type { CustomSection, DiscussionItem, FunctionScore, SafeguardResult } from '@mashit/core';
import { MASH_IT_BRAND, type BrandTokens } from './brand.js';
import { formatPercent, formatTrend, formatValue, ratingClass } from './format.js';
import type { ReportModel, ReportSection } from './model.js';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Split free text into HTML paragraphs on blank lines. */
function paragraphs(body: string): string {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
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
.logos{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin:0 0 20px}
.logo{max-height:64px;max-width:280px;display:block}
.meta{color:#555;margin:2px 0}
table{width:100%;border-collapse:collapse;margin:8px 0}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e3e3e3;vertical-align:top}
th{color:#555;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
.num{text-align:right;font-variant-numeric:tabular-nums}
.trend-up{color:#c62828}.trend-down{color:#2e7d32}
.chip{display:inline-block;padding:2px 10px;border-radius:12px;color:#fff;font-weight:600;font-size:12px}
.rating-green{background:#2e7d32}.rating-amber{background:#ed9c28}.rating-red{background:#c62828}.rating-unknown{background:#9e9e9e}
.disp{background:#0b2545;font-size:11px}
.scorecard{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:12px 0}
.fn{border:1px solid #e3e3e3;border-radius:8px;padding:10px}
.fn .score{font-size:22px;font-weight:700;color:var(--primary)}
.headline{font-size:16px;font-weight:600;color:var(--primary);margin:0 0 8px}
.note{background:#f6f8fa;border-left:3px solid var(--accent);padding:8px 12px;margin:8px 0;white-space:pre-wrap}
ul{margin:6px 0;padding-left:20px}
@page{size:Letter;margin:14mm}
@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;
}

function renderLogos(brand: BrandTokens): string {
  const org = `<img class="logo" src="${esc(brand.orgLogoDataUri)}" alt="${esc(brand.orgName)} logo">`;
  const client = brand.logoDataUri ? `<img class="logo" src="${esc(brand.logoDataUri)}" alt="${esc(brand.name)} logo">` : '';
  return `<div class="logos">${org}${client}</div>`;
}

function renderCover(m: ReportModel): string {
  return `<section class="page">
  ${renderLogos(m.brand)}
  <div class="brandbar">${esc(m.brand.name)} &middot; Quarterly Business Review</div>
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
  ${m.executive.highlights.length ? `<ul>${m.executive.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
</section>`;
}

function renderCustomSection(s: CustomSection): string {
  return `<h2>${esc(s.title)}</h2>\n${paragraphs(s.body)}`;
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
  ${s.remediations.length ? `<h2>Priority Remediations</h2><ul>${s.remediations.map(remediation).join('')}</ul>` : ''}
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

const DISPOSITION_LABEL: Record<string, string> = {
  pending: 'Pending',
  create_opportunity: 'Opportunity',
  create_ticket: 'Ticket',
  accept_risk: 'Accept risk',
  no_action: 'No action',
};

function renderDiscussion(m: ReportModel): string {
  if (m.discussion.length === 0 && !m.notes) return '';
  const row = (d: DiscussionItem) =>
    `<tr><td>${esc(d.topic)}</td><td>${esc(d.response ?? '')}</td><td>${
      d.disposition ? `<span class="chip disp">${esc(DISPOSITION_LABEL[d.disposition] ?? d.disposition)}</span>` : ''
    }${d.owner ? `<br><span class="meta">${esc(d.owner)}</span>` : ''}</td></tr>`;
  const table = m.discussion.length
    ? `<table><thead><tr><th>Discussion / Decision</th><th>Client response &amp; notes</th><th>Disposition</th></tr></thead>
       <tbody>${m.discussion.map(row).join('\n')}</tbody></table>`
    : '';
  const notes = m.notes ? `<div class="note">${esc(m.notes)}</div>` : '';
  return `<section class="page"><h2>Discussion &amp; Responses</h2>${table}${notes}</section>`;
}

function renderBody(m: ReportModel): string {
  const inBody = m.customSections.filter((s) => (s.placement ?? 'in-body') === 'in-body');
  const atEnd = m.customSections.filter((s) => s.placement === 'end');
  if (m.sections.length === 0 && inBody.length === 0 && m.recommendations.length === 0 && atEnd.length === 0) return '';
  return `<section class="page">
  ${m.sections.map(renderSection).join('\n')}
  ${inBody.map(renderCustomSection).join('\n')}
  ${m.recommendations.length ? `<h2>Recommendations &amp; Next 90 Days</h2><ul>${m.recommendations.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
  ${atEnd.map(renderCustomSection).join('\n')}
</section>`;
}

function renderAppendix(m: ReportModel): string {
  if (!m.documents.length) return '';
  const item = (d: { name: string; source: string }) => `<li><strong>${esc(d.name)}</strong> <span class="meta">(${esc(d.source)})</span></li>`;
  return `<section class="page"><h2>Appendix &mdash; Attached Reports</h2>
  <p class="meta">The following source reports accompany this review:</p>
  <ul>${m.documents.map(item).join('')}</ul></section>`;
}

/** Render the full branded QBR report as a single self-contained HTML document. */
export function renderReportHtml(model: ReportModel): string {
  const brand = model.brand ?? MASH_IT_BRAND;
  const afterSummary = model.customSections.filter((s) => s.placement === 'after-summary');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(model.client.name)} — ${esc(model.period.label)} QBR</title>
<style>${styles(brand)}</style></head>
<body>
${renderCover(model)}
${renderExecutive(model)}
${afterSummary.length ? `<section class="page">${afterSummary.map(renderCustomSection).join('\n')}</section>` : ''}
${renderScorecard(model)}
${renderBody(model)}
${renderDiscussion(model)}
${renderAppendix(model)}
</body></html>`;
}
