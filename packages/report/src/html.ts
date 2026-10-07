import type { CustomSection, DiscussionItem, FunctionScore, SafeguardResult } from '@mashit/core';
import { MASH_IT_BRAND, type BrandTokens } from './brand.js';
import {
  formatPercent,
  formatTrend,
  formatValue,
  ratingClass,
  ratingWord,
  discussionOutcome,
  goalStatusLabel,
  goalStatusColor,
  SEMANTIC,
} from './format.js';
import { moversBarChartSvg, moversCaption, selectKpiTiles, type KpiTile } from './charts.js';
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

/** Human names for the NIST CSF 2.0 functions (the report never shouts the enum). */
const FUNCTION_NAME: Record<string, string> = {
  GOVERN: 'Govern',
  IDENTIFY: 'Identify',
  PROTECT: 'Protect',
  DETECT: 'Detect',
  RESPOND: 'Respond',
  RECOVER: 'Recover',
};

/**
 * One stylesheet, one type family, one semantic palette. Brand tokens are
 * validated upstream (resolveBrand) so interpolating them here is safe.
 */
function styles(brand: BrandTokens): string {
  return `
:root{--primary:${brand.primary};--accent:${brand.accent};--ink:${brand.ink};--bg:${brand.bg};
--text:${SEMANTIC.text};--muted:${SEMANTIC.muted};--hair:${SEMANTIC.hairline};--canvas:${SEMANTIC.canvas};
--good:${SEMANTIC.good};--watch:${SEMANTIC.watch};--watch-bg:${SEMANTIC.watchBg};--act:${SEMANTIC.act};--unknown:${SEMANTIC.unknown};--unknown-bg:${SEMANTIC.unknownBg};}
*{box-sizing:border-box}
html{background:var(--canvas)}
body{font-family:"Public Sans",${brand.font};color:var(--text);margin:0;background:var(--bg);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}
.page{max-width:820px;margin:0 auto;padding:44px 52px;background:var(--bg);page-break-after:always}
.page:last-child{page-break-after:auto}
h1,h2,h3{color:var(--primary);font-weight:600;line-height:1.2;margin:0}
h1{font-size:34px;letter-spacing:-.01em;margin:18px 0 6px}
h2{font-size:18px;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--hair)}
h3{font-size:15px;margin:18px 0 6px}
p{margin:0 0 10px;max-width:68ch}
.num,td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}
.small{font-size:12px}
.logos{display:flex;justify-content:space-between;align-items:center;gap:24px}
.logo{max-height:64px;max-width:280px;display:block}
.logo-client{max-height:96px;max-width:200px;display:block}
.tagline{color:var(--muted);font-size:12px;margin:4px 0 0}
.kicker{color:var(--accent);font-weight:600;font-size:13px;margin-top:26px}
.meta{color:var(--muted);font-size:12px;margin:0 0 4px}
.headline{font-size:28px;font-weight:600;color:var(--primary);line-height:1.2;max-width:30ch;margin:22px 0 12px}
.lede p{font-size:14px;line-height:1.55}
ul{margin:6px 0 10px;padding-left:20px}
li{margin:2px 0;max-width:68ch}
.tiles{display:grid;gap:10px;margin:20px 0 6px}
.tile{background:var(--canvas);border-radius:8px;padding:14px 16px}
.tile .v{font-size:26px;font-weight:600;line-height:1.1;font-variant-numeric:tabular-nums}
.tile .l{font-size:12px;color:var(--text);margin-top:4px}
.tile .n{font-size:12px;color:var(--muted);margin-top:2px}
.tile .n.good{color:var(--good)}.tile .n.bad{color:var(--act)}
.confidence{background:var(--watch-bg);border-left:3px solid var(--watch);padding:10px 14px;margin:16px 0}
.confidence h3{color:var(--watch);margin:0 0 4px;font-size:13px}
.confidence ul{margin:0;padding-left:18px}
.confidence li{color:var(--text)}
.figure{margin:18px 0 6px}
.figure .fig-title{font-weight:600;color:var(--primary);font-size:14px;margin:0}
.figure .fig-cap{color:var(--muted);font-size:12px;margin:2px 0 8px}
.figure svg{max-width:100%;height:auto;display:block}
table{width:100%;border-collapse:collapse;margin:6px 0 14px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--hair);vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:12px}
.trend-bad{color:var(--act)}.trend-good{color:var(--good)}
.chip{display:inline-block;padding:2px 9px;border-radius:4px;font-weight:600;font-size:12px;color:#fff}
.rating-green{background:var(--good)}.rating-amber{background:var(--watch)}.rating-red{background:var(--act)}
.rating-unknown{background:var(--unknown-bg);color:var(--unknown)}
.disp{background:var(--primary);font-size:11px}
.maturity{display:flex;gap:20px;align-items:flex-start;margin:12px 0 18px}
.maturity .big{font-size:48px;font-weight:600;line-height:1;font-variant-numeric:tabular-nums;color:var(--primary);min-width:96px}
.maturity .big.none{font-size:22px;color:var(--unknown);padding-top:8px}
.maturity .word{font-size:15px;font-weight:600;margin:0 0 4px}
.scorecard{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:12px 0}
.fn{border:1px solid var(--hair);border-radius:4px;padding:10px 12px}
.fn .fn-name{font-size:12px;color:var(--muted)}
.fn .score{font-size:22px;font-weight:600;color:var(--primary);font-variant-numeric:tabular-nums;margin:2px 0}
.fn .score.none{font-size:14px;color:var(--unknown)}
.note{background:var(--canvas);border-left:3px solid var(--accent);padding:8px 12px;margin:8px 0;white-space:pre-wrap}
.section-summary{border-left:3px solid var(--accent);padding:4px 12px;margin:4px 0 10px;color:var(--text);max-width:68ch}
.goal{border:1px solid var(--hair);border-left:3px solid var(--accent);border-radius:4px;padding:10px 12px;margin:8px 0}
.goal .g-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.goal .g-title{font-weight:600;color:var(--primary)}
.goal .g-align{color:var(--text);margin:6px 0 0}
.goal .g-target{color:var(--muted);font-size:12px}
@page{size:Letter;margin:14mm}
@media print{h1,h2,h3{break-after:avoid}.tiles,.figure,.confidence,.section-summary,.goal,tr{break-inside:avoid}html{background:#fff}.page{max-width:none;padding:0}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
@media (max-width:640px){.page{padding:24px 16px}.scorecard{grid-template-columns:1fr 1fr}.tiles{grid-template-columns:1fr 1fr !important}.headline{font-size:22px}h1{font-size:28px}}
`;
}

function renderLogos(brand: BrandTokens): string {
  const org = `<div><img class="logo" src="${esc(brand.orgLogoDataUri)}" alt="${esc(brand.orgName)} logo">${
    brand.tagline ? `<div class="tagline">${esc(brand.tagline)}</div>` : ''
  }</div>`;
  // The client's logo sits larger so it reads as a peer to the MSP wordmark
  // (client logos are often small squares next to a wide wordmark).
  const client = brand.logoDataUri ? `<img class="logo-client" src="${esc(brand.logoDataUri)}" alt="${esc(brand.name)} logo">` : '';
  return `<div class="logos">${org}${client}</div>`;
}

/** The "quarter at a glance" tiles: the score with its confidence, then the headline numbers with their movement. */
function renderTiles(m: ReportModel): string {
  const tiles = selectKpiTiles(m);
  if (tiles.length < 2) return '';
  const tile = (t: KpiTile) =>
    `<div class="tile"><div class="v" style="color:${t.color}">${esc(t.value)}</div><div class="l">${esc(t.label)}</div>${
      t.note ? `<div class="n ${t.noteTone === 'good' ? 'good' : t.noteTone === 'bad' ? 'bad' : ''}">${esc(t.note)}</div>` : ''
    }</div>`;
  return `<div class="tiles" style="grid-template-columns:repeat(${tiles.length},1fr)">${tiles.map(tile).join('')}</div>`;
}

/** Sync caveats, so a sampled count is never read as a complete one. */
function renderConfidence(m: ReportModel): string {
  if (!m.dataConfidence.length) return '';
  return `<div class="confidence"><h3>Data confidence</h3><ul>${m.dataConfidence.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`;
}

/** "What changed this quarter": diverging bars of the top QoQ movers. */
function renderMovers(m: ReportModel): string {
  const svg = moversBarChartSvg(m.trends);
  if (!svg) return '';
  return `<div class="figure">
    <p class="fig-title">What changed this quarter</p>
    <p class="fig-cap">${esc(moversCaption(m.trends))}</p>
    ${svg}
  </div>`;
}

/**
 * The opening page: who and when, the headline, the narrative, the numbers
 * that matter, and how far to trust them. An executive who reads only this
 * page has the quarter.
 */
function renderOpening(m: ReportModel): string {
  const meta = [
    m.heldBy ? `Review held by ${esc(m.heldBy)}` : '',
    m.client.primaryContact ? `Prepared for ${esc(m.client.primaryContact)}` : '',
    m.generatedLabel ? esc(m.generatedLabel) : '',
    m.client.hipaa ? 'Contains confidential client information (HIPAA)' : '',
  ].filter(Boolean);
  return `<section class="page">
  ${renderLogos(m.brand)}
  <div class="kicker">Quarterly business review from ${esc(m.brand.name)}, ${esc(m.period.label)}</div>
  <h1>${esc(m.client.name)}</h1>
  ${meta.map((line) => `<p class="meta">${line}.</p>`).join('\n')}
  ${m.executive.headline ? `<p class="headline">${esc(m.executive.headline)}</p>` : ''}
  <div class="lede">${m.executive.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('\n')}</div>
  ${m.executive.highlights.length ? `<ul>${m.executive.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
  ${renderTiles(m)}
  ${renderConfidence(m)}
  ${renderMovers(m)}
</section>`;
}

function renderGoals(m: ReportModel): string {
  if (m.goals.length === 0) return '';
  const goal = (g: (typeof m.goals)[number]) => `<div class="goal">
    <div class="g-head">
      <div>
        <div class="g-title">${esc(g.title)}</div>
        ${g.targetPeriod ? `<div class="g-target">Target: ${esc(g.targetPeriod)}</div>` : ''}
      </div>
      <span class="chip" style="background:${goalStatusColor(g.status)}">${esc(goalStatusLabel(g.status))}</span>
    </div>
    ${g.alignment ? `<p class="g-align">${esc(g.alignment)}</p>` : ''}
  </div>`;
  return `<section class="page">
  <h2>Strategic Goals &amp; IT Alignment</h2>
  <p class="meta">Your business objectives and how our services support them.</p>
  ${m.goals.map(goal).join('\n')}
</section>`;
}

function renderCustomSection(s: CustomSection): string {
  return `<h2>${esc(s.title)}</h2>\n${paragraphs(s.body)}`;
}

/**
 * The maturity block is honest about how much it measured: a withheld score
 * with low coverage, a provisional one with medium coverage, and "not
 * measured" (in slate, never a colour) for any function without data.
 */
function renderScorecard(m: ReportModel): string {
  const s = m.scorecard;
  const { score, rating, coverage, confidence } = s.overall;
  const coverageText = `${formatPercent(Math.round(coverage * 100))} of the controls we check could be measured this quarter`;
  const unmeasured = s.functions.filter((f) => f.score === null).map((f) => FUNCTION_NAME[f.function] ?? f.function);
  const headline =
    score === null || confidence === 'low'
      ? `<div class="maturity"><div class="big none">Not scored</div><div>
          <p class="word">Not enough security data to score this quarter.</p>
          <p class="small muted">Only ${coverageText}. Connecting the remaining tools lets the score appear next quarter; nothing here should be read as a failing grade.</p>
        </div></div>`
      : `<div class="maturity"><div class="big">${Math.round(score)}</div><div>
          <p class="word"><span class="chip ${ratingClass(rating)}">${esc(ratingWord(rating))}</span> out of 100${confidence === 'medium' ? ', provisional' : ''}</p>
          <p class="small muted">${coverageText}${confidence === 'medium' ? '; the score firms up as more tools are connected' : ''}.${
            unmeasured.length ? ` Not yet measured: ${esc(unmeasured.join(', '))}.` : ''
          }</p>
        </div></div>`;
  const fnCard = (f: FunctionScore) =>
    f.score === null
      ? `<div class="fn"><div class="fn-name">${esc(FUNCTION_NAME[f.function] ?? f.function)}</div><div class="score none">Not measured</div></div>`
      : `<div class="fn"><div class="fn-name">${esc(FUNCTION_NAME[f.function] ?? f.function)}</div><div class="score">${Math.round(f.score)}</div><span class="chip ${ratingClass(f.rating)}">${esc(ratingWord(f.rating))}</span></div>`;
  const remediation = (r: SafeguardResult) => `<li><strong>${esc(r.title)}</strong>: ${esc(r.evidence)}</li>`;
  return `<section class="page">
  <h2>Security &amp; Risk Maturity</h2>
  ${headline}
  <div class="scorecard">${s.functions.map(fnCard).join('')}</div>
  <p class="small muted">How to read this: we check the safeguards protecting your business (MFA, endpoint protection, patching, backups and more) against
  CIS Controls v8, an industry checklist of security best practices, and group the results under the six NIST Cybersecurity Framework
  functions so you can see where defenses are strong and where to invest. It is a posture guide, not a compliance certification.${
    m.client.complianceStandard
      ? ` Because ${esc(m.client.name)} answers to ${esc(m.client.complianceStandard)}, findings are weighed with ${esc(m.client.complianceStandard)} expectations in mind.`
      : ''
  }</p>
  ${s.remediations.length ? `<h2>Priority Remediations</h2><ul>${s.remediations.map(remediation).join('')}</ul>` : ''}
</section>`;
}

/** A metric section: the one-line takeaway, then the table. The "vs last" column exists only when something can be compared. */
function renderSection(section: ReportSection): string {
  const hasPrior = section.rows.some(({ trend }) => trend && trend.previous !== null && trend.direction !== 'na');
  const rows = section.rows
    .map(({ metric, trend }) => {
      const t = hasPrior && trend ? formatTrend(trend) : '';
      const cls = trend?.sentiment === 'negative' ? 'trend-bad' : trend?.sentiment === 'positive' ? 'trend-good' : '';
      return `<tr><td>${esc(metric.label)}</td><td class="num">${esc(formatValue(metric))}</td>${
        hasPrior ? `<td class="num ${cls}">${esc(t)}</td>` : ''
      }</tr>`;
    })
    .join('\n');
  return `<h2>${esc(section.title)}</h2>
  ${section.summary ? `<p class="section-summary">${esc(section.summary)}</p>` : ''}
  <table><thead><tr><th>Metric</th><th class="num">This quarter</th>${hasPrior ? '<th class="num">vs last</th>' : ''}</tr></thead>
  <tbody>${rows}</tbody></table>`;
}

function renderDiscussion(m: ReportModel): string {
  if (m.discussion.length === 0 && !m.notes) return '';
  const row = (d: DiscussionItem) =>
    `<tr><td>${esc(d.topic)}</td><td>${esc(d.response ?? '')}</td><td><span class="chip disp">${esc(discussionOutcome(d))}</span>${
      d.owner ? `<br><span class="meta">${esc(d.owner)}</span>` : ''
    }</td></tr>`;
  const table = m.discussion.length
    ? `<table><thead><tr><th>Discussion / Decision</th><th>Client response &amp; notes</th><th>Disposition</th></tr></thead>
       <tbody>${m.discussion.map(row).join('\n')}</tbody></table>`
    : '';
  const notes = m.notes ? `<div class="note">${esc(m.notes)}</div>` : '';
  return `<section class="page"><h2>Active &amp; Pending Conversations</h2>${table}${notes}</section>`;
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
  return `<section class="page"><h2>Appendix: Attached Reports</h2>
  <p class="meta">The following source reports accompany this review:</p>
  <ul>${m.documents.map(item).join('')}</ul></section>`;
}

/** Render the full branded QBR report as a single self-contained HTML document. */
export function renderReportHtml(model: ReportModel): string {
  const brand = model.brand ?? MASH_IT_BRAND;
  const afterSummary = model.customSections.filter((s) => s.placement === 'after-summary');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(model.client.name)} QBR, ${esc(model.period.label)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${styles(brand)}</style></head>
<body>
${renderOpening(model)}
${renderGoals(model)}
${afterSummary.length ? `<section class="page">${afterSummary.map(renderCustomSection).join('\n')}</section>` : ''}
${renderScorecard(model)}
${renderBody(model)}
${renderDiscussion(model)}
${renderAppendix(model)}
</body></html>`;
}
