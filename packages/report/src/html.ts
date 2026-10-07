import type { BudgetOutlook, CustomSection } from '@mashit/core';
import { MASH_IT_BRAND, type BrandTokens } from './brand.js';
import { formatTrend, formatValue, ratingClass, ratingWord, goalStatusLabel, goalStatusColor, SEMANTIC } from './format.js';
import { investmentBarsSvg, moversBarChartSvg, moversCaption, planMeterSvg, selectKpiTiles, type KpiTile } from './charts.js';
import { conversationStatus, type InvestmentModel, type ReportModel, type ReportSection } from './model.js';
import {
  basisText,
  BUDGET_CATEGORY_LABEL,
  conversationColor,
  CONVERSATION_LABEL,
  decisionSubline,
  DECISIONS_LEDE,
  DENSE_TABLE_ROWS,
  footerText,
  functionScoresText,
  hasPlan,
  howWeScore,
  investmentLede,
  investmentTiles,
  money,
  PAGE_TITLES,
  PLAN_COLUMNS,
  planningDecisions,
  PLANNING_LEDE,
  planDecisionLabel,
  planningTitle,
  planVsActualText,
  PROTECTION_SUBTITLE,
  protectionInPlace,
  protectionStatusWord,
  protectionThisQuarter,
  ringNote,
  showDecisionsPage,
  showInvestmentPage,
  sinceColor,
  sinceLabel,
  whatToFixFirst,
} from './pages.js';

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

/**
 * One stylesheet, one type family, one semantic palette. Brand tokens are
 * validated upstream (resolveBrand) so interpolating them here is safe. Body
 * text is 14px (10.5pt in print) and nothing is set under 11px; the print
 * rules keep tiles, columns, callouts and charts in one piece.
 */
function styles(brand: BrandTokens): string {
  return `
:root{--primary:${brand.primary};--accent:${brand.accent};--ink:${brand.ink};--bg:${brand.bg};
--text:${SEMANTIC.text};--muted:${SEMANTIC.muted};--hair:${SEMANTIC.hairline};--canvas:${SEMANTIC.canvas};
--good:${SEMANTIC.good};--watch:${SEMANTIC.watch};--watch-bg:${SEMANTIC.watchBg};--act:${SEMANTIC.act};--unknown:${SEMANTIC.unknown};--unknown-bg:${SEMANTIC.unknownBg};}
*{box-sizing:border-box}
html{background:var(--canvas)}
body{font-family:"Public Sans",${brand.font};color:var(--text);margin:0;background:var(--bg);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
.page{max-width:820px;margin:0 auto;padding:44px 52px;background:var(--bg);page-break-after:always}
.page:last-of-type{page-break-after:auto}
h1,h2,h3{color:var(--primary);font-weight:600;line-height:1.2;margin:0}
h1{font-size:34px;letter-spacing:-.01em;margin:18px 0 6px}
h2{font-size:18px;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--hair)}
h2.page-title{font-size:26px;border:0;margin:0 0 12px;padding:0}
h3{font-size:15px;margin:0 0 8px}
p{margin:0 0 10px;max-width:68ch}
.num,td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}
.small{font-size:12px}
.logos{display:flex;justify-content:space-between;align-items:center;gap:24px}
.logo{max-height:64px;max-width:280px;display:block}
.logo-client{max-height:96px;max-width:200px;display:block}
.tagline{color:var(--muted);font-size:12px;margin:4px 0 0}
.kicker{color:var(--accent);font-weight:600;font-size:14px;margin-top:96px}
.meta{color:var(--muted);font-size:12px;margin:0 0 4px}
.headline{font-size:28px;font-weight:600;color:var(--primary);line-height:1.2;max-width:30ch;margin:0 0 12px}
.lede{font-size:16px;line-height:1.55;max-width:60ch}
ul{margin:6px 0 10px;padding-left:20px}
li{margin:2px 0 6px;max-width:68ch}
.tiles{display:grid;gap:10px;margin:20px 0 6px}
.tile{background:var(--canvas);border-radius:8px;padding:14px 16px}
.tile .v{font-size:26px;font-weight:600;line-height:1.1;font-variant-numeric:tabular-nums}
.tile .l{font-size:12px;color:var(--text);margin-top:4px}
.tile .n{font-size:12px;color:var(--muted);margin-top:2px}
.tile .n.good{color:var(--good)}.tile .n.bad{color:var(--act)}
.cols{display:grid;grid-template-columns:1fr 1fr 1.08fr;gap:20px;margin-top:22px}
.col{border-top:2px solid var(--hair);padding-top:10px}
.col.need{border-top-color:var(--watch);background:var(--watch-bg);padding:10px 12px;border-radius:0 0 6px 6px}
.col.need h3{color:var(--watch)}
.decision{display:flex;gap:8px;margin:0 0 10px}
.box{width:11px;height:11px;border:1px solid var(--watch);border-radius:2px;flex:none;margin-top:5px}
.decision small{display:block;color:var(--muted);font-size:12px}
.since{border-left:4px solid var(--primary);background:var(--canvas);padding:10px 14px;margin:22px 0 0}
.since b{color:var(--ink);display:block;margin-bottom:4px}
.since .row{display:flex;justify-content:space-between;gap:16px;margin-top:4px}
.since .st{font-weight:600;white-space:nowrap}
.confidence{background:var(--watch-bg);border-left:3px solid var(--watch);padding:10px 14px;margin:16px 0}
.confidence h3{color:var(--watch);margin:0 0 4px;font-size:14px}
.confidence ul{margin:0;padding-left:18px}
.confidence li{color:var(--text)}
.figure{margin:18px 0 6px}
.figure .fig-title{font-weight:600;color:var(--primary);font-size:15px;margin:0}
.figure .fig-cap{color:var(--muted);font-size:12px;margin:2px 0 8px}
.figure svg{max-width:100%;height:auto;display:block}
table{width:100%;border-collapse:collapse;margin:6px 0 14px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--hair);vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:12px}
.trend-bad{color:var(--act)}.trend-good{color:var(--good)}
.chip{display:inline-block;padding:2px 9px;border-radius:10px;font-weight:600;font-size:12px;color:#fff}
.rating-green{background:var(--good)}.rating-amber{background:var(--watch)}.rating-red{background:var(--act)}
.rating-unknown{background:var(--unknown-bg);color:var(--unknown)}
.ring{display:flex;gap:20px;align-items:center;margin:4px 0 14px}
.ring .big{font-size:44px;font-weight:600;line-height:1;font-variant-numeric:tabular-nums;color:var(--primary);min-width:84px}
.ring .big.none{font-size:22px;color:var(--unknown)}
.prot td.q{font-weight:600;color:var(--ink);width:22%}
.prot td.q small,.prot td.st small{display:block;font-weight:400;color:var(--muted);font-size:12px;margin-top:4px}
.prot td.st{width:16%;white-space:nowrap}
.callout{border-left:3px solid var(--accent);background:var(--canvas);padding:10px 14px;margin:14px 0}
.callout.fix{border-left-color:var(--watch);background:var(--watch-bg)}
.callout.fix b{color:var(--watch)}
.plan{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-top:8px}
.plan .col h3 span{font-weight:400;color:var(--muted);font-size:12px;margin-left:6px}
.plan .it{margin:0 0 12px}
.plan .it b{display:block;color:var(--ink)}
.plan .who{display:block;color:var(--muted);font-size:12px}
.plan .dec{display:block;color:var(--watch);font-size:12px;font-weight:600}
.note{background:var(--canvas);border-left:3px solid var(--accent);padding:8px 12px;margin:8px 0;white-space:pre-wrap}
.section-summary{border-left:3px solid var(--accent);padding:4px 12px;margin:4px 0 10px;color:var(--text);max-width:68ch}
.goal{border:1px solid var(--hair);border-left:3px solid var(--accent);border-radius:4px;padding:10px 12px;margin:8px 0}
.goal .g-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.goal .g-title{font-weight:600;color:var(--primary)}
.goal .g-align{color:var(--text);margin:6px 0 0}
.goal .g-target{color:var(--muted);font-size:12px}
.foot{max-width:820px;margin:0 auto;padding:12px 52px 32px;color:var(--muted);font-size:12px}
@page{size:Letter;margin:0.75in}
@media print{h1,h2,h3{break-after:avoid}.tiles,.cols,.since,.figure,.callout,.plan,.ring,.confidence,.section-summary,.goal,tr{break-inside:avoid}html{background:#fff}.page{max-width:none;padding:0}.foot{padding:12px 0 0}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
@media (max-width:640px){.page{padding:24px 16px}.cols,.plan{grid-template-columns:1fr}.tiles{grid-template-columns:1fr 1fr !important}.headline{font-size:22px}h1{font-size:28px}}
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

/** Cover: who and when. */
function renderCover(m: ReportModel): string {
  const meta = [
    m.client.primaryContact ? `Prepared for ${esc(m.client.primaryContact)}` : '',
    m.heldBy ? `Presented by ${esc(m.heldBy)}` : '',
    m.generatedLabel ? esc(m.generatedLabel) : '',
    m.client.hipaa ? 'Contains confidential client information (HIPAA)' : '',
  ].filter(Boolean);
  return `<section class="page cover" data-page="cover">
  ${renderLogos(m.brand)}
  <div class="kicker">Quarterly business review from ${esc(m.brand.name)}</div>
  <h1>${esc(m.client.name)}</h1>
  <p class="meta">${esc(m.period.label)}</p>
  ${meta.map((line) => `<p class="meta">${line}.</p>`).join('\n')}
</section>`;
}

/** Page one: an executive who reads only this page has the quarter. */
function renderPageOne(m: ReportModel): string {
  const list = (items: string[]) => (items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="small muted">Nothing to report this quarter.</p>');
  const decisions = m.decisions.length
    ? m.decisions
        .map((d) => {
          const sub = decisionSubline(d);
          return `<div class="decision"><span class="box"></span><span>${esc(d.ask)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></div>`;
        })
        .join('')
    : '<p>Nothing needs your decision this quarter.</p>';
  const since = m.sinceLastQuarter.length
    ? `<div class="since"><b>Since last quarter</b>${m.sinceLastQuarter
        .map(
          (r) =>
            `<div class="row"><span>${esc(r.topic)}${r.detail ? `<br><span class="small muted">${esc(r.detail)}</span>` : ''}</span><span class="st" style="color:${sinceColor(r)}">${esc(sinceLabel(r))}</span></div>`,
        )
        .join('')}</div>`
    : '';
  return `<section class="page" data-page="one">
  <h1 class="headline">${esc(m.executive.headline || PAGE_TITLES.fallbackHeadline)}</h1>
  ${m.executive.lede ? `<p class="lede">${esc(m.executive.lede)}</p>` : ''}
  ${renderTiles(m)}
  ${renderConfidence(m)}
  <div class="cols">
    <div class="col"><h3>What we did</h3>${list(m.executive.did)}</div>
    <div class="col"><h3>What we saw</h3>${list(m.executive.saw)}</div>
    <div class="col need"><h3>What we need from you</h3>${decisions}</div>
  </div>
  ${since}
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
  return `<section class="page" data-page="goals">
  <h2 class="page-title">${PAGE_TITLES.goals}</h2>
  <p class="meta">Your business objectives and how our services support them.</p>
  ${m.goals.map(goal).join('\n')}
</section>`;
}

function renderCustomSection(s: CustomSection): string {
  return `<h2>${esc(s.title)}</h2>\n${paragraphs(s.body)}`;
}

/** Page two: the ring and its honesty note, the five questions, what to fix first. */
function renderProtection(m: ReportModel): string {
  const { score, rating, confidence } = m.scorecard.overall;
  const withheld = score === null || confidence === 'low';
  const ring = withheld
    ? `<div class="ring"><div class="big none">Not scored</div><p class="small">${esc(ringNote(m))}</p></div>`
    : `<div class="ring"><div class="big">${Math.round(score)}</div><div><p><span class="chip ${ratingClass(rating)}">${esc(ratingWord(rating))}</span> out of 100</p><p class="small muted">${esc(ringNote(m))}</p></div></div>`;
  const rows = m.protection
    .map(
      (row) =>
        `<tr><td class="q">${esc(row.question)}<small>${esc(PROTECTION_SUBTITLE[row.id] ?? '')}</small></td><td>${esc(protectionInPlace(row))}</td><td>${esc(
          protectionThisQuarter(row),
        )}</td><td class="st"><span class="chip ${ratingClass(row.rating)}">${esc(protectionStatusWord(row))}</span><small>${esc(functionScoresText(row))}</small></td></tr>`,
    )
    .join('\n');
  const fix = whatToFixFirst(m);
  return `<section class="page" data-page="protection">
  <h2 class="page-title">${PAGE_TITLES.protection}</h2>
  ${ring}
  <table class="prot"><thead><tr><th>The question</th><th>What is in place</th><th>This quarter</th><th>Status</th></tr></thead>
  <tbody>${rows}</tbody></table>
  ${fix ? `<div class="callout fix"><b>What to fix first</b><br>${esc(fix)}</div>` : ''}
</section>`;
}

/** Page three: what we are tracking with you, then Now / Next / Later. */
function renderDecisions(m: ReportModel): string {
  if (!showDecisionsPage(m)) return '';
  const rows = m.discussion
    .map((d) => {
      const status = conversationStatus(d);
      return `<tr><td><strong>${esc(d.topic)}</strong></td><td>${esc(d.response?.trim() || 'To discuss')}</td><td>${esc(d.owner ?? '')}</td><td><span class="chip" style="background:${conversationColor(
        status,
        m.brand.primary,
      )}">${esc(CONVERSATION_LABEL[status])}</span></td></tr>`;
    })
    .join('\n');
  const table = m.discussion.length
    ? `<h2>What we are tracking with you</h2><table><thead><tr><th>Topic</th><th>Where it stands</th><th>Owner</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`
    : '';
  const notes = m.notes ? `<h2>Meeting notes</h2><div class="note">${esc(m.notes)}</div>` : '';
  const plan = hasPlan(m)
    ? `<h2${m.discussion.length > DENSE_TABLE_ROWS ? ' style="break-before:page"' : ''}>The next 90 days</h2><div class="plan">${PLAN_COLUMNS.map(
        (c) =>
          `<div class="col"><h3>${c.title}<span>${c.span}</span></h3>${
            m.plan[c.key].length
              ? m.plan[c.key]
                  .map(
                    (p) =>
                      `<div class="it"><b>${esc(p.action)}</b><span class="who">${esc(p.owner)}</span>${p.decision ? `<span class="dec">${esc(planDecisionLabel(m, p) ?? '')}</span>` : ''}</div>`,
                  )
                  .join('')
              : '<p class="small muted">Nothing planned yet.</p>'
          }</div>`,
      ).join('')}</div>`
    : '';
  return `<section class="page" data-page="decisions">
  <h2 class="page-title">${PAGE_TITLES.decisions}</h2>
  <p class="muted">${esc(DECISIONS_LEDE)}</p>
  ${table}${notes}${plan}
</section>`;
}

/** Page four: invested, recurring versus project work, where it went, plan versus actual, coming up. */
function renderInvestment(m: ReportModel, inv: InvestmentModel): string {
  const tiles = inv.invoiced > 0
    ? `<div class="tiles" style="grid-template-columns:repeat(3,1fr)">${investmentTiles(inv)
        .map((t) => `<div class="tile"><div class="v" style="color:${m.brand.primary}">${esc(t.value)}</div><div class="l">${esc(t.label)}</div>${t.note ? `<div class="n">${esc(t.note)}</div>` : ''}</div>`)
        .join('')}</div>`
    : '';
  const bars = investmentBarsSvg(inv.breakdown, 716, { recurring: m.brand.primary, variable: '#8fb3e6' });
  const p = inv.planVsActual;
  return `<section class="page" data-page="investment">
  <h2 class="page-title">${PAGE_TITLES.investment}</h2>
  ${investmentLede(inv) ? `<p class="lede">${esc(investmentLede(inv))}</p>` : ''}
  ${tiles}
  ${bars ? `<div class="figure"><p class="fig-title">Where it went</p>${bars}<p class="fig-cap">Darker bars are recurring services; lighter bars are project and support work.</p></div>` : ''}
  ${p ? `<div class="callout"><b>${esc(p.fiscalYearLabel)} plan versus actual</b>${planMeterSvg(p.pct, 680)}<p>${esc(planVsActualText(p))}</p></div>` : ''}
  ${inv.comingUp.length ? `<h2>Coming up</h2><ul>${inv.comingUp.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
</section>`;
}

/** Page 4b, planning quarter only. */
function renderPlanning(outlook: BudgetOutlook): string {
  const row = (label: string, low: number, expected: number, high: number, basis: string, bold = false) =>
    `<tr><td><strong>${esc(label)}</strong></td><td class="num">${bold ? '<strong>' : ''}${money(low)}${bold ? '</strong>' : ''}</td><td class="num">${bold ? '<strong>' : ''}${money(
      expected,
    )}${bold ? '</strong>' : ''}</td><td class="num">${bold ? '<strong>' : ''}${money(high)}${bold ? '</strong>' : ''}</td><td>${esc(basis)}</td></tr>`;
  return `<section class="page" data-page="planning">
  <h2 class="page-title">${esc(planningTitle(outlook))}</h2>
  <p>${esc(PLANNING_LEDE)}</p>
  <table><thead><tr><th>Category</th><th class="num">Low</th><th class="num">Expected</th><th class="num">High</th><th>Based on</th></tr></thead>
  <tbody>${outlook.lines.map((l) => row(BUDGET_CATEGORY_LABEL[l.category] ?? l.category, l.low, l.expected, l.high, basisText(l))).join('')}${row(
    'Total',
    outlook.totals.low,
    outlook.totals.expected,
    outlook.totals.high,
    '',
    true,
  )}</tbody></table>
  ${outlook.caveats.length ? `<ul class="small muted">${outlook.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
  ${outlook.assumptions.length ? `<div class="callout"><b>What we assumed with you.</b> ${esc(outlook.assumptions.join(' '))}</div>` : ''}
  ${outlook.movers.length ? `<div class="callout"><b>What would move it.</b> ${esc(outlook.movers.join(' '))}</div>` : ''}
  <h2>Decisions for the plan</h2><ul>${planningDecisions(outlook).map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
</section>`;
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

function renderNumbers(m: ReportModel): string {
  const inBody = m.customSections.filter((s) => (s.placement ?? 'in-body') === 'in-body');
  const atEnd = m.customSections.filter((s) => s.placement === 'end');
  const movers = renderMovers(m);
  if (m.sections.length === 0 && !movers && inBody.length === 0 && atEnd.length === 0) return '';
  return `<section class="page" data-page="numbers">
  ${m.sections.length || movers ? `<h2 class="page-title">${PAGE_TITLES.numbers}</h2>` : ''}
  ${movers}
  ${m.sections.map(renderSection).join('\n')}
  ${inBody.map(renderCustomSection).join('\n')}
  ${atEnd.map(renderCustomSection).join('\n')}
</section>`;
}

function renderAppendix(m: ReportModel): string {
  const item = (d: { name: string; source: string }) => `<li><strong>${esc(d.name)}</strong> <span class="meta">(${esc(d.source)})</span></li>`;
  const reports = m.documents.length
    ? `<p class="meta">The following source reports accompany this review:</p><ul>${m.documents.map(item).join('')}</ul><h2>How we score</h2>`
    : '';
  return `<section class="page" data-page="appendix"><h2 class="page-title">${m.documents.length ? PAGE_TITLES.appendixWithReports : PAGE_TITLES.appendixScoring}</h2>
  ${reports}<p>${esc(howWeScore(m))}</p></section>`;
}

/** Render the full branded QBR report as a single self-contained HTML document. */
export function renderReportHtml(model: ReportModel): string {
  const brand = model.brand ?? MASH_IT_BRAND;
  const afterSummary = model.customSections.filter((s) => s.placement === 'after-summary');
  const inv = model.investment;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(model.client.name)} QBR, ${esc(model.period.label)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${styles(brand)}</style></head>
<body>
${renderCover(model)}
${renderPageOne(model)}
${renderGoals(model)}
${afterSummary.length ? `<section class="page" data-page="custom">${afterSummary.map(renderCustomSection).join('\n')}</section>` : ''}
${renderProtection(model)}
${renderDecisions(model)}
${showInvestmentPage(inv) ? renderInvestment(model, inv) : ''}
${inv?.outlook ? renderPlanning(inv.outlook) : ''}
${renderNumbers(model)}
${renderAppendix(model)}
<footer class="foot">${esc(footerText(model))}</footer>
</body></html>`;
}
