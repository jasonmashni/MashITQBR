import type { BudgetOutlook, FunctionScore, MetricTrend, Rating } from '@mashit/core';
import type { BrandTokens } from './brand.js';
import { formatValue, ratingColor, ratingWord, trendDeltaText, goalStatusLabel, goalStatusColor, SEMANTIC } from './format.js';
import { investmentBarsSvg, moversBarChartSvg, moversCaption, planMeterSvg, selectKpiTiles } from './charts.js';
import { isRenderableRaster } from './images.js';
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

/**
 * Designed, branded PDF built with pdfmake (pure JS — no Chromium, so it runs
 * on the Azure Consumption plan). Uses the PDF standard Helvetica faces (no
 * font files to ship); score visuals are generated as inline SVG. pdfmake is
 * imported dynamically so the package still builds/tests without it installed.
 *
 * Executive-first page order, shared with the HTML and the deck: cover; page
 * one (headline, lede, tiles, what we did / saw / need from you, since last
 * quarter); how we are protecting you; decisions and the next 90 days; your
 * IT investment (plus the planning page in the planning quarter); quarter in
 * numbers; appendix. Readability is a hard rule: body 10pt or larger, nothing
 * under 8pt, 0.75in margins, headings keep with next, charts, tile bands and
 * callouts never split, tables repeat their header row. When content does
 * not fit, the page count grows; sizes never shrink. The score is withheld on
 * thin data and the "vs last" column exists only when something can be
 * compared. Sentence case throughout; nothing is uppercased or letter-spaced.
 */

type Node = Record<string, unknown> | string;

const GRAY = SEMANTIC.muted;
const TEXT = SEMANTIC.text;
const RULE = SEMANTIC.hairline;
const CANVAS = SEMANTIC.canvas;

/** Human names for the NIST CSF 2.0 functions. */
const FUNCTION_NAME: Record<string, string> = {
  GOVERN: 'Govern',
  IDENTIFY: 'Identify',
  PROTECT: 'Protect',
  DETECT: 'Detect',
  RESPOND: 'Respond',
  RECOVER: 'Recover',
};

/** Donut gauge for the overall maturity score; "Not scored" when withheld. */
export function donutSvg(score: number | null, rating: Rating, size = 150): string {
  const c = size / 2;
  const r = size / 2 - 14;
  const circumference = 2 * Math.PI * r;
  const pct = score === null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const color = score === null ? SEMANTIC.unknownBg : ratingColor(rating);
  const label = score === null ? 'Not scored' : String(Math.round(score));
  const labelSize = score === null ? size / 10 : size / 4;
  // pdfkit rejects a zero-length dash ("dash([0, n]) invalid"), so the
  // progress arc is only drawn when there is a score to draw.
  const arc =
    pct > 0
      ? `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="14"
 stroke-linecap="round" stroke-dasharray="${(pct * circumference).toFixed(1)} ${circumference.toFixed(1)}"
 transform="rotate(-90 ${c} ${c})"/>`
      : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${SEMANTIC.unknownBg}" stroke-width="14"/>
${arc}
<text x="${c}" y="${c + 2}" text-anchor="middle" font-family="Helvetica, Arial" font-size="${labelSize}" font-weight="bold" fill="${score === null ? GRAY : SEMANTIC.ink}">${label}</text>
${score === null ? '' : `<text x="${c}" y="${c + size / 5.4}" text-anchor="middle" font-family="Helvetica, Arial" font-size="${size / 12}" fill="${GRAY}">of 100</text>`}
</svg>`;
}

/** Horizontal score bars, one per NIST function; unmeasured functions say so in slate. */
export function functionBarsSvg(functions: FunctionScore[], width = 320): string {
  const rowH = 26;
  const barX = 72;
  const barW = width - barX - 88;
  const rows = functions
    .map((f, i) => {
      const y = i * rowH + 6;
      const w = f.score === null ? 0 : Math.max(2, (barW * Math.max(0, Math.min(100, f.score))) / 100);
      const color = ratingColor(f.rating);
      const label = f.score === null ? 'Not measured' : `${Math.round(f.score)}  ${ratingWord(f.rating)}`;
      return `<text x="0" y="${y + 12}" font-family="Helvetica, Arial" font-size="10" fill="${SEMANTIC.ink}" font-weight="bold">${FUNCTION_NAME[f.function] ?? f.function}</text>
<rect x="${barX}" y="${y}" width="${barW}" height="14" rx="3" fill="${SEMANTIC.unknownBg}"/>
${f.score === null ? '' : `<rect x="${barX}" y="${y}" width="${w.toFixed(1)}" height="14" rx="3" fill="${color}"/>`}
<text x="${barX + barW + 8}" y="${y + 12}" font-family="Helvetica, Arial" font-size="9.5" fill="${f.score === null ? GRAY : TEXT}">${label}</text>`;
    })
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${functions.length * rowH + 8}" viewBox="0 0 ${width} ${functions.length * rowH + 8}">${rows}</svg>`;
}

/** A logo node: data-URI SVGs become svg nodes, verified rasters become image nodes. */
function logoNode(dataUri: string | undefined, opts: { width?: number; height?: number; alignment?: string } = {}): Node | undefined {
  if (!dataUri) return undefined;
  if (dataUri.startsWith('data:image/svg')) {
    try {
      const b64 = dataUri.split(',')[1] ?? '';
      const svg = dataUri.includes(';base64,') ? Buffer.from(b64, 'base64').toString('utf8') : decodeURIComponent(b64);
      return { svg, fit: [opts.width ?? 170, opts.height ?? 44], alignment: opts.alignment };
    } catch {
      return undefined;
    }
  }
  // pdfmake throws on undecodable images; a truncated or mislabeled upload is
  // skipped so a bad logo never kills the whole PDF.
  if (!isRenderableRaster(dataUri)) return undefined;
  return { image: dataUri, fit: [opts.width ?? 170, opts.height ?? 44], alignment: opts.alignment };
}

/**
 * Trend text safe for the PDF standard fonts (no ▲/▼/→ — those glyphs aren't
 * in Helvetica's WinAnsi set). The sign + color carry the direction.
 */
function pdfTrend(t: MetricTrend): string {
  return trendDeltaText(t).replace(' → ', ' to ');
}

/** Light callout block with an accent left bar (section takeaways, notes). */
function calloutBlock(text: string, accent: string, margin: number[] = [0, 2, 0, 10], fill = CANVAS): Node {
  return {
    table: {
      widths: [3, '*'],
      body: [
        [
          { text: '', fillColor: accent, border: [false, false, false, false] },
          { text, style: 'body', margin: [8, 6, 8, 6], fillColor: fill, border: [false, false, false, false], color: TEXT },
        ],
      ],
    },
    layout: { defaultBorder: false, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 },
    unbreakable: true,
    margin,
  };
}

/** Sync caveats, so a sampled count is never read as a complete one. */
function confidenceBlock(m: ReportModel): Node | undefined {
  if (!m.dataConfidence.length) return undefined;
  return {
    table: {
      widths: [3, '*'],
      body: [
        [
          { text: '', fillColor: SEMANTIC.watch, border: [false, false, false, false] },
          {
            stack: [
              { text: 'Data confidence', bold: true, fontSize: 10.5, color: SEMANTIC.watch, margin: [0, 0, 0, 3] },
              { ul: m.dataConfidence.map((w) => ({ text: w, fontSize: 10, color: TEXT, margin: [0, 1, 0, 1] })) },
            ],
            margin: [8, 6, 8, 6],
            fillColor: SEMANTIC.watchBg,
            border: [false, false, false, false],
          },
        ],
      ],
    },
    layout: { defaultBorder: false, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 },
    unbreakable: true,
    margin: [0, 4, 0, 12],
  };
}

function sectionTable(section: ReportSection, brand: BrandTokens): Node {
  const hasPrior = section.rows.some(({ trend }) => trend && trend.previous !== null && trend.direction !== 'na');
  const header: unknown[] = [
    { text: 'Metric', style: 'th' },
    { text: 'This quarter', style: 'th', alignment: 'right' },
    ...(hasPrior ? [{ text: 'vs last', style: 'th', alignment: 'right' }] : []),
  ];
  const body: unknown[][] = [
    header,
    ...section.rows.map(({ metric, trend }) => {
      const t = hasPrior && trend ? pdfTrend(trend) : '';
      const color = trend?.sentiment === 'negative' ? SEMANTIC.act : trend?.sentiment === 'positive' ? SEMANTIC.good : GRAY;
      return [
        { text: metric.label, style: 'td' },
        { text: formatValue(metric), style: 'td', alignment: 'right' },
        ...(hasPrior ? [{ text: t, style: 'td', alignment: 'right', color }] : []),
      ];
    }),
  ];
  return {
    stack: [
      { text: section.title, style: 'h2', headlineLevel: 2, color: brand.primary },
      ...(section.summary ? [calloutBlock(section.summary, brand.accent)] : []),
      {
        table: { headerRows: 1, widths: hasPrior ? ['*', 90, 70] : ['*', 110], body },
        layout: {
          hLineWidth: (i: number) => (i <= 1 ? 1 : 0.5),
          vLineWidth: () => 0,
          hLineColor: (i: number) => (i <= 1 ? brand.accent : RULE),
          fillColor: (rowIndex: number) => (rowIndex > 0 && rowIndex % 2 === 0 ? '#f7f9fb' : null),
          paddingTop: () => 5,
          paddingBottom: () => 5,
          paddingLeft: () => 4,
          paddingRight: () => 4,
        },
      },
    ],
    margin: [0, 0, 0, 16],
    unbreakable: section.rows.length <= 12,
  };
}

/** The stat band on the opening page: the quarter at a glance, each number with its movement or confidence. */
function kpiBand(m: ReportModel): Node | undefined {
  const tiles = selectKpiTiles(m);
  if (tiles.length < 2) return undefined;
  const toneColor = (tone: string | undefined) => (tone === 'good' ? SEMANTIC.good : tone === 'bad' ? SEMANTIC.act : GRAY);
  return {
    unbreakable: true,
    table: {
      widths: tiles.map(() => '*'),
      body: [
        tiles.map((t) => ({
          stack: [
            { text: t.value, fontSize: t.value.length > 6 ? 14 : 22, bold: true, color: t.color, alignment: 'left' },
            { text: t.label, fontSize: 8.5, color: TEXT, alignment: 'left', margin: [0, 3, 0, 0] },
            ...(t.note ? [{ text: t.note, fontSize: 8, color: toneColor(t.noteTone), alignment: 'left', margin: [0, 1, 0, 0] }] : []),
          ],
          fillColor: CANVAS,
          margin: [8, 10, 8, 10],
        })),
      ],
    },
    layout: {
      defaultBorder: false,
      vLineWidth: () => 4,
      vLineColor: () => '#ffffff',
      hLineWidth: () => 0,
    },
    margin: [0, 6, 0, 10],
  };
}

/** LETTER page geometry (points). */
const PAGE = { width: 612, height: 792 };
const COVER_BAND_H = 132;

function coverPage(m: ReportModel): Node[] {
  const brand = m.brand;
  const logos: Node[] = [];
  const org = logoNode(brand.orgLogoDataUri, { width: 200, height: 54 });
  const client = logoNode(brand.logoDataUri, { width: 160, height: 82, alignment: 'right' });
  const orgBlock: Node | undefined = org
    ? { width: '*', stack: [org, ...(brand.tagline ? [{ text: brand.tagline, color: GRAY, fontSize: 9.5, margin: [0, 5, 0, 0] as number[] }] : [])] }
    : undefined;
  // Logos are drawn as svg or image nodes; like every chart they never split.
  if (orgBlock && client) logos.push({ unbreakable: true, columns: [orgBlock, { width: 'auto', stack: [client] }], columnGap: 16 });
  else if (orgBlock) logos.push({ unbreakable: true, stack: [orgBlock] });

  const meta: Node[] = [];
  if (m.client.primaryContact) meta.push({ text: [{ text: 'Prepared for  ', color: GRAY }, { text: m.client.primaryContact, bold: true }], margin: [0, 2, 0, 2] });
  if (m.heldBy) meta.push({ text: [{ text: 'Presented by  ', color: GRAY }, { text: m.heldBy, bold: true }], margin: [0, 2, 0, 2] });
  if (m.generatedLabel) meta.push({ text: [{ text: 'Date  ', color: GRAY }, { text: m.generatedLabel, bold: true }], margin: [0, 2, 0, 2] });

  return [
    ...logos,
    { text: '', margin: [0, 96, 0, 0] },
    { canvas: [{ type: 'rect', x: 0, y: 0, w: 90, h: 5, color: brand.accent }] },
    { text: 'Quarterly business review', color: brand.accent, fontSize: 14, bold: true, margin: [0, 14, 0, 6] },
    { text: m.client.name, color: brand.primary, fontSize: 34, bold: true, margin: [0, 0, 0, 6] },
    { text: m.period.label, color: GRAY, fontSize: 17, margin: [0, 0, 0, 26] },
    { stack: meta, fontSize: 11 },
    // White text sits inside the brand band the background paints at the foot.
    {
      text: `${m.client.name}, ${m.period.label}`,
      color: '#ffffff',
      fontSize: 13,
      bold: true,
      absolutePosition: { x: 52, y: PAGE.height - COVER_BAND_H + 40 },
    },
    { text: '', pageBreak: 'after' },
  ];
}

/** Page backgrounds: a bold brand band on the cover, a slim top bar after. */
function pageBackground(brand: BrandTokens): (page: number) => unknown {
  return (page: number) => {
    if (page === 1) {
      return {
        canvas: [
          { type: 'rect', x: 0, y: 0, w: PAGE.width, h: 8, color: brand.accent },
          { type: 'rect', x: 0, y: PAGE.height - COVER_BAND_H, w: PAGE.width, h: COVER_BAND_H, color: brand.primary },
          { type: 'rect', x: 0, y: PAGE.height - COVER_BAND_H - 6, w: PAGE.width, h: 6, color: brand.accent },
        ],
      };
    }
    return {
      canvas: [
        { type: 'rect', x: 0, y: 0, w: PAGE.width, h: 5, color: brand.primary },
        { type: 'rect', x: 0, y: 0, w: 170, h: 5, color: brand.accent },
      ],
    };
  };
}

/** Content width on Letter at the 54pt side margins. */
const CONTENT_W = PAGE.width - 2 * 54;

const tableLayout = (brand: BrandTokens) => ({
  hLineWidth: (i: number) => (i <= 1 ? 1 : 0.5),
  vLineWidth: () => 0,
  hLineColor: (i: number) => (i <= 1 ? brand.accent : RULE),
  paddingTop: () => 6,
  paddingBottom: () => 6,
  paddingLeft: () => 4,
  paddingRight: () => 4,
});

const zeroPadding = { defaultBorder: false, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 };

/** A shaded block with an accent bar that never splits (Since last quarter, What to fix first, assumptions). */
function panel(stack: Node[], accent: string, fill: string, margin: number[] = [0, 10, 0, 10]): Node {
  return {
    unbreakable: true,
    table: {
      widths: [3, '*'],
      body: [
        [
          { text: '', fillColor: accent, border: [false, false, false, false] },
          { stack, margin: [10, 8, 10, 8], fillColor: fill, border: [false, false, false, false] },
        ],
      ],
    },
    layout: zeroPadding,
    margin,
  };
}

/** Status chip as an inline highlighted run. */
function chip(word: string, fill: string): Node {
  return { text: ` ${word} `, color: '#ffffff', background: fill, bold: true, fontSize: 9 };
}

/** Page one: headline, lede, tiles, what we did / saw / need, since last quarter. */
function pageOne(m: ReportModel): Node[] {
  const brand = m.brand;
  const out: Node[] = [{ text: m.executive.headline || PAGE_TITLES.fallbackHeadline, style: 'h1', headlineLevel: 1, color: brand.primary }];
  if (m.executive.lede) out.push({ text: m.executive.lede, style: 'lede' });
  const band = kpiBand(m);
  if (band) out.push(band);
  const confidence = confidenceBlock(m);
  if (confidence) out.push(confidence);

  const list = (title: string, items: string[]): Node => ({
    width: '*',
    stack: [
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 150, y2: 0, lineWidth: 2, lineColor: RULE }], margin: [0, 0, 0, 6] },
      { text: title, style: 'h3', color: brand.primary },
      items.length
        ? { ul: items.map((t) => ({ text: t, style: 'body', margin: [0, 0, 0, 4] })) }
        : { text: 'Nothing to report this quarter.', style: 'small' },
    ],
  });
  const decisions: Node[] = m.decisions.length
    ? m.decisions.map((d) => ({
        columns: [
          { width: 12, canvas: [{ type: 'rect', x: 0, y: 3, w: 7, h: 7, r: 1, lineWidth: 1, lineColor: SEMANTIC.watch }] },
          {
            width: '*',
            stack: [
              { text: d.ask, style: 'body', margin: [0, 0, 0, 1] },
              ...(decisionSubline(d) ? [{ text: decisionSubline(d), style: 'small' }] : []),
            ],
          },
        ],
        margin: [0, 0, 0, 6],
      }))
    : [{ text: 'Nothing needs your decision this quarter.', style: 'body' }];
  const need: Node = {
    width: '*',
    table: {
      widths: ['*'],
      body: [[{ stack: [{ text: 'What we need from you', style: 'h3', color: SEMANTIC.watch }, ...decisions], fillColor: SEMANTIC.watchBg, margin: [8, 8, 8, 4] }]],
    },
    layout: { defaultBorder: false, hLineWidth: (i: number) => (i === 0 ? 2 : 0), hLineColor: () => SEMANTIC.watch, vLineWidth: () => 0, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 },
  };
  out.push({ unbreakable: true, columns: [list('What we did', m.executive.did), list('What we saw', m.executive.saw), need], columnGap: 16, margin: [0, 12, 0, 0] });

  if (m.sinceLastQuarter.length) {
    out.push(
      panel(
        [
          { text: 'Since last quarter', bold: true, color: SEMANTIC.ink, fontSize: 10.5, margin: [0, 0, 0, 4] },
          ...m.sinceLastQuarter.map((r) => ({
            columns: [
              { width: '*', stack: [{ text: r.topic, style: 'td' }, ...(r.detail ? [{ text: r.detail, style: 'small' }] : [])] },
              { width: 'auto', text: sinceLabel(r), bold: true, fontSize: 10, color: sinceColor(r) },
            ],
            columnGap: 12,
            margin: [0, 2, 0, 2],
          })),
        ],
        brand.primary,
        CANVAS,
        [0, 14, 0, 0],
      ),
    );
  }
  return out;
}

/** Page two: the ring and its honesty note, the five questions, what to fix first. */
function protectionPage(m: ReportModel): Node[] {
  const brand = m.brand;
  const { score, rating, confidence } = m.scorecard.overall;
  const withheld = score === null || confidence === 'low';
  const out: Node[] = [{ text: PAGE_TITLES.protection, style: 'h1', headlineLevel: 1, color: brand.primary, pageBreak: 'before' }];
  out.push({
    unbreakable: true,
    columns: [
      withheld
        ? { width: 96, text: 'Not scored', fontSize: 16, bold: true, color: GRAY, margin: [0, 28, 0, 0] }
        : { width: 96, stack: [{ svg: donutSvg(score, rating, 96), width: 96 }] },
      { width: '*', text: ringNote(m), style: 'body', margin: [0, withheld ? 22 : 20, 0, 0] },
    ],
    columnGap: 16,
    margin: [0, 0, 0, 10],
  });
  const body: unknown[][] = [
    [
      { text: 'The question', style: 'th' },
      { text: 'What is in place', style: 'th' },
      { text: 'This quarter', style: 'th' },
      { text: 'Status', style: 'th' },
    ],
    ...m.protection.map((row) => [
      { stack: [{ text: row.question, bold: true, color: SEMANTIC.ink, fontSize: 10 }, { text: PROTECTION_SUBTITLE[row.id] ?? '', style: 'small', margin: [0, 2, 0, 0] }] },
      { text: protectionInPlace(row), style: 'td' },
      { text: protectionThisQuarter(row), style: 'td' },
      { stack: [{ text: [chip(protectionStatusWord(row), ratingColor(row.rating))] }, { text: functionScoresText(row), style: 'small', margin: [0, 4, 0, 0] }] },
    ]),
  ];
  out.push({ table: { headerRows: 1, dontBreakRows: true, widths: [104, '*', '*', 78], body }, layout: tableLayout(brand), margin: [0, 0, 0, 8] });
  const fix = whatToFixFirst(m);
  if (fix) out.push(panel([{ text: 'What to fix first', bold: true, color: SEMANTIC.watch, margin: [0, 0, 0, 2] }, { text: fix, style: 'body', margin: [0, 0, 0, 0] }], SEMANTIC.watch, SEMANTIC.watchBg));
  return out;
}

/** Page three: what we are tracking with you, then Now / Next / Later. */
function decisionsPage(m: ReportModel): Node[] {
  const brand = m.brand;
  const out: Node[] = [
    { text: PAGE_TITLES.decisions, style: 'h1', headlineLevel: 1, color: brand.primary, pageBreak: 'before' },
    { text: DECISIONS_LEDE, style: 'body', color: GRAY },
  ];
  if (m.discussion.length) {
    out.push({ text: 'What we are tracking with you', style: 'h2', headlineLevel: 2, color: brand.primary });
    const body: unknown[][] = [
      [
        { text: 'Topic', style: 'th' },
        { text: 'Where it stands', style: 'th' },
        { text: 'Owner', style: 'th' },
        { text: 'Status', style: 'th' },
      ],
      ...m.discussion.map((d) => {
        const status = conversationStatus(d);
        return [
          { text: d.topic, style: 'td', bold: true, color: SEMANTIC.ink },
          { text: d.response?.trim() || 'To discuss', style: 'td' },
          { text: d.owner ?? '', style: 'td' },
          { text: [chip(CONVERSATION_LABEL[status], conversationColor(status, brand.primary))] },
        ];
      }),
    ];
    out.push({ table: { headerRows: 1, dontBreakRows: true, widths: [130, '*', 70, 70], body }, layout: tableLayout(brand) });
  }
  if (m.notes) {
    out.push({ text: 'Meeting notes', style: 'h2', headlineLevel: 2, color: brand.primary });
    out.push({ text: m.notes, style: 'body', italics: true });
  }
  if (hasPlan(m)) {
    out.push({
      text: 'The next 90 days',
      style: 'h2',
      headlineLevel: 2,
      color: brand.primary,
      ...(m.discussion.length > DENSE_TABLE_ROWS ? { pageBreak: 'before' } : {}),
    });
    out.push({
      unbreakable: true,
      columnGap: 16,
      columns: PLAN_COLUMNS.map((c) => ({
        width: '*',
        stack: [
          { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 150, y2: 0, lineWidth: 2, lineColor: RULE }], margin: [0, 0, 0, 6] },
          { text: [{ text: c.title, bold: true, color: brand.primary, fontSize: 11 }, { text: `  ${c.span}`, fontSize: 8.5, color: GRAY }], margin: [0, 0, 0, 6] },
          ...(m.plan[c.key].length
            ? m.plan[c.key].map((p) => ({
                stack: [
                  { text: p.action, bold: true, fontSize: 10.5, color: SEMANTIC.ink },
                  { text: p.owner, style: 'small' },
                  ...(p.decision ? [{ text: planDecisionLabel(m, p), bold: true, fontSize: 8.5, color: SEMANTIC.watch }] : []),
                ],
                margin: [0, 0, 0, 8],
              }))
            : [{ text: 'Nothing planned yet.', style: 'small' }]),
        ],
      })),
    });
  }
  return out;
}

/** Page four: invested, recurring versus project work, where it went, plan versus actual, coming up. */
function investmentPage(m: ReportModel, inv: InvestmentModel): Node[] {
  const brand = m.brand;
  const out: Node[] = [{ text: PAGE_TITLES.investment, style: 'h1', headlineLevel: 1, color: brand.primary, pageBreak: 'before' }];
  const lede = investmentLede(inv);
  if (lede) out.push({ text: lede, style: 'lede' });
  if (inv.invoiced > 0) {
    out.push({
      unbreakable: true,
      table: {
        widths: ['*', '*', '*'],
        body: [
          investmentTiles(inv).map((t) => ({
            stack: [
              { text: t.value, fontSize: 20, bold: true, color: brand.primary },
              { text: t.label, fontSize: 8.5, color: TEXT, margin: [0, 3, 0, 0] },
              ...(t.note ? [{ text: t.note, fontSize: 8, color: GRAY, margin: [0, 1, 0, 0] }] : []),
            ],
            fillColor: CANVAS,
            margin: [8, 10, 8, 10],
          })),
        ],
      },
      layout: { defaultBorder: false, vLineWidth: () => 4, vLineColor: () => '#ffffff', hLineWidth: () => 0 },
      margin: [0, 6, 0, 10],
    });
  }
  const bars = investmentBarsSvg(inv.breakdown, CONTENT_W, { recurring: brand.primary, variable: '#8fb3e6' });
  if (bars) {
    out.push({
      unbreakable: true,
      stack: [
        { text: 'Where it went', style: 'h2', headlineLevel: 2, color: brand.primary },
        { svg: bars, width: CONTENT_W },
        { text: 'Darker bars are recurring services; lighter bars are project and support work.', style: 'small', margin: [0, 4, 0, 0] },
      ],
    });
  }
  if (inv.planVsActual) {
    const p = inv.planVsActual;
    out.push(
      panel(
        [
          { text: `${p.fiscalYearLabel} plan versus actual`, bold: true, color: SEMANTIC.ink, margin: [0, 0, 0, 4] },
          { svg: planMeterSvg(p.pct, CONTENT_W - 40, { elapsedPct: p.elapsedPct }), width: CONTENT_W - 40, margin: [0, 0, 0, 4] },
          { text: planVsActualText(p), style: 'body', margin: [0, 0, 0, 0] },
        ],
        brand.primary,
        CANVAS,
        [0, 12, 0, 6],
      ),
    );
  }
  if (inv.comingUp.length) {
    out.push({ text: 'Coming up', style: 'h2', headlineLevel: 2, color: brand.primary });
    out.push({ ul: inv.comingUp.map((c) => ({ text: c, style: 'body', margin: [0, 0, 0, 3] })) });
  }
  return out;
}

/** Page 4b, planning quarter only: the twelve-month outlook built with the client. */
function planningPage(m: ReportModel, outlook: BudgetOutlook): Node[] {
  const brand = m.brand;
  const out: Node[] = [
    { text: planningTitle(outlook), style: 'h1', headlineLevel: 1, color: brand.primary, pageBreak: 'before' },
    { text: PLANNING_LEDE, style: 'body' },
  ];
  const r = (n: number) => ({ text: money(n), style: 'td', alignment: 'right' });
  const body: unknown[][] = [
    [
      { text: 'Category', style: 'th' },
      { text: 'Low', style: 'th', alignment: 'right' },
      { text: 'Expected', style: 'th', alignment: 'right' },
      { text: 'High', style: 'th', alignment: 'right' },
      { text: 'Based on', style: 'th' },
    ],
    ...outlook.lines.map((line) => [
      { text: BUDGET_CATEGORY_LABEL[line.category] ?? line.category, style: 'td', bold: true, color: SEMANTIC.ink },
      r(line.low),
      r(line.expected),
      r(line.high),
      { text: basisText(line), style: 'td' },
    ]),
    [
      { text: 'Total', style: 'td', bold: true, color: SEMANTIC.ink },
      { ...r(outlook.totals.low), bold: true },
      { ...r(outlook.totals.expected), bold: true },
      { ...r(outlook.totals.high), bold: true },
      { text: '', style: 'td' },
    ],
  ];
  out.push({ table: { headerRows: 1, dontBreakRows: true, widths: [104, 60, 64, 60, '*'], body }, layout: tableLayout(brand), margin: [0, 4, 0, 6] });
  if (outlook.caveats.length) out.push({ ul: outlook.caveats.map((c) => ({ text: c, style: 'small' })), margin: [0, 0, 0, 6] });
  if (outlook.assumptions.length) {
    out.push(panel([{ text: [{ text: 'What we assumed with you. ', bold: true, color: SEMANTIC.ink }, { text: outlook.assumptions.join(' ') }], style: 'body', margin: [0, 0, 0, 0] }], brand.primary, CANVAS, [0, 6, 0, 4]));
  }
  if (outlook.movers.length) {
    out.push(panel([{ text: [{ text: 'What would move it. ', bold: true, color: SEMANTIC.ink }, { text: outlook.movers.join(' ') }], style: 'body', margin: [0, 0, 0, 0] }], brand.primary, CANVAS, [0, 4, 0, 6]));
  }
  out.push({ text: 'Decisions for the plan', style: 'h2', headlineLevel: 2, color: brand.primary });
  out.push({ ul: planningDecisions(outlook).map((d) => ({ text: d, style: 'body' })) });
  return out;
}

/** Strategic goals and how IT supports them (qualitative, so no guardrail concern). */
function goalsPage(m: ReportModel): Node[] {
  const brand = m.brand;
  const out: Node[] = [
    { text: PAGE_TITLES.goals, style: 'h1', headlineLevel: 1, color: brand.primary, pageBreak: 'before' },
    { text: 'Your business objectives and how our services support them.', style: 'small', margin: [0, 0, 0, 8] },
  ];
  for (const g of m.goals) {
    out.push({
      unbreakable: true,
      table: {
        widths: ['*', 'auto'],
        body: [
          [
            {
              stack: [
                { text: g.title, bold: true, color: brand.primary, fontSize: 11 },
                ...(g.targetPeriod ? [{ text: `Target: ${g.targetPeriod}`, style: 'small', margin: [0, 1, 0, 0] as number[] }] : []),
                ...(g.alignment ? [{ text: g.alignment, style: 'body', margin: [0, 4, 0, 0] as number[] }] : []),
              ],
              margin: [10, 8, 10, 8],
            },
            { text: goalStatusLabel(g.status), color: '#ffffff', fillColor: goalStatusColor(g.status), bold: true, fontSize: 8.5, alignment: 'center', margin: [8, 8, 8, 8] },
          ],
        ],
      },
      layout: { defaultBorder: false, fillColor: (i: number) => (i === 0 ? CANVAS : null) },
      margin: [0, 0, 0, 8],
    });
  }
  return out;
}

function customSectionNodes(cs: { title: string; body: string }, brand: BrandTokens): Node[] {
  return [
    { text: cs.title, style: 'h2', headlineLevel: 2, color: brand.primary },
    ...cs.body
      .split(/\n\s*\n/)
      .filter(Boolean)
      .map((p) => ({ text: p.trim(), style: 'body' })),
  ];
}

/** Build the full pdfmake document definition (exported for tests). */
export function buildPdfDefinition(m: ReportModel): Record<string, unknown> {
  const brand = m.brand;
  const content: Node[] = [...coverPage(m), ...pageOne(m)];

  if (m.goals.length) content.push(...goalsPage(m));
  for (const cs of m.customSections.filter((s) => s.placement === 'after-summary')) content.push(...customSectionNodes(cs, brand));

  content.push(...protectionPage(m));
  if (showDecisionsPage(m)) content.push(...decisionsPage(m));
  if (showInvestmentPage(m.investment)) content.push(...investmentPage(m, m.investment));
  if (m.investment?.outlook) content.push(...planningPage(m, m.investment.outlook));

  // Quarter in numbers: the movers chart (one unbreakable block with its caption), then the tables.
  const moversSvg = moversBarChartSvg(m.trends, { width: CONTENT_W });
  if (m.sections.length || moversSvg) {
    content.push({ text: PAGE_TITLES.numbers, style: 'h1', headlineLevel: 1, color: brand.primary, pageBreak: 'before' });
    if (moversSvg) {
      content.push({
        unbreakable: true,
        stack: [
          { text: 'What changed this quarter', style: 'h2', headlineLevel: 2, color: brand.primary, margin: [0, 0, 0, 2] },
          { text: moversCaption(m.trends), style: 'small', margin: [0, 0, 0, 6] },
          { svg: moversSvg, width: CONTENT_W, margin: [0, 0, 0, 8] },
        ],
      });
    }
    for (const section of m.sections) content.push(sectionTable(section, brand));
  }
  for (const cs of m.customSections.filter((c) => (c.placement ?? 'in-body') === 'in-body')) content.push(...customSectionNodes(cs, brand));
  for (const cs of m.customSections.filter((c) => c.placement === 'end')) content.push(...customSectionNodes(cs, brand));

  // Appendix: attached vendor reports, then how the score works.
  content.push({
    text: m.documents.length ? PAGE_TITLES.appendixWithReports : PAGE_TITLES.appendixScoring,
    style: 'h1',
    headlineLevel: 1,
    color: brand.primary,
    pageBreak: 'before',
  });
  if (m.documents.length) {
    content.push({ text: 'The following source reports accompany this review:', style: 'body' });
    content.push({
      ul: m.documents.map((d) => ({ text: [{ text: d.name, bold: true }, { text: `  (${d.source})`, color: GRAY }], style: 'body', margin: [0, 1, 0, 1] })),
    });
    content.push({ text: 'How we score', style: 'h2', headlineLevel: 2, color: brand.primary });
  }
  content.push({ text: howWeScore(m), style: 'body' });

  return {
    content,
    pageSize: 'LETTER',
    pageMargins: [54, 62, 54, 58],
    background: pageBackground(brand),
    info: { title: `${m.client.name} QBR, ${m.period.label}`, author: brand.orgName },
    defaultStyle: { font: 'Helvetica', fontSize: 10.5, color: TEXT, lineHeight: 1.35 },
    styles: {
      h1: { fontSize: 20, bold: true, lineHeight: 1.2, margin: [0, 0, 0, 10] },
      h2: { fontSize: 13, bold: true, margin: [0, 12, 0, 6] },
      h3: { fontSize: 11, bold: true, margin: [0, 0, 0, 6] },
      th: { fontSize: 8.5, bold: true, color: GRAY },
      td: { fontSize: 10, lineHeight: 1.35 },
      body: { fontSize: 10.5, lineHeight: 1.4, margin: [0, 0, 0, 6] },
      lede: { fontSize: 12, lineHeight: 1.45, margin: [0, 0, 0, 8] },
      small: { fontSize: 8.5, color: GRAY },
    },
    header: (page: number) =>
      page === 1
        ? undefined
        : {
            columns: [
              { text: `${brand.orgName} quarterly business review`, color: GRAY, fontSize: 8 },
              { text: `${m.client.name}, ${m.period.label}`, color: GRAY, fontSize: 8, alignment: 'right' },
            ],
            margin: [54, 26, 54, 0],
          },
    // Headings keep with next: pdfmake reads headlineLevel only through this callback.
    // A heading with nothing after it on its page moves to the next page. The
    // callback must declare both parameters or pdfmake skips collecting the list.
    pageBreakBefore: (node: { headlineLevel?: number }, followingNodesOnPage: unknown[]) =>
      Boolean(node.headlineLevel) && followingNodesOnPage.length === 0,
    footer: (page: number, pages: number) => ({
      columns: [
        { text: footerText(m), color: GRAY, fontSize: 8 },
        { text: `Page ${page} of ${pages}`, color: GRAY, fontSize: 8, alignment: 'right', width: 70 },
      ],
      margin: [54, 20, 54, 0],
    }),
  };
}

/** Render the designed, branded QBR PDF from the report model. */
export async function renderPdf(model: ReportModel): Promise<Buffer> {
  // Variable specifier avoids a hard compile-time dependency on the lib.
  const spec = 'pdfmake';
  let mod: any;
  try {
    mod = await import(spec);
  } catch {
    throw new Error("renderPdf requires the 'pdfmake' dependency. Install it to enable PDF export.");
  }
  const PdfPrinter = mod.default ?? mod;
  // The PDF standard 14 fonts ship inside every reader; nothing to embed.
  const printer = new PdfPrinter({
    Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' },
  });
  const render = (def: Record<string, unknown>) =>
    new Promise<Buffer>((resolve, reject) => {
      try {
        const doc = printer.createPdfKitDocument(def);
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.end();
      } catch (e) {
        reject(e);
      }
    });
  try {
    return await render(buildPdfDefinition(model));
  } catch (e) {
    // pdfmake throws plain strings for image problems ("Invalid image: ...").
    // A corrupt uploaded logo must not block the deliverable: retry without logos.
    const message = e instanceof Error ? e.message : String(e);
    if (/image/i.test(message)) {
      const stripped = { ...model, brand: { ...model.brand, logoDataUri: undefined, orgLogoDataUri: '' } };
      return render(buildPdfDefinition(stripped));
    }
    throw e;
  }
}
