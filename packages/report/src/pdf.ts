import type { DiscussionItem, FunctionScore, MetricTrend, Rating } from '@mashit/core';
import type { BrandTokens } from './brand.js';
import { formatPercent, formatValue, ratingColor, discussionOutcome } from './format.js';
import type { ReportModel, ReportSection } from './model.js';

/**
 * Designed, branded PDF built with pdfmake (pure JS — no Chromium, so it runs
 * on the Azure Consumption plan). Uses the PDF standard Helvetica faces (no
 * font files to ship); score visuals are generated as inline SVG. pdfmake is
 * imported dynamically so the package still builds/tests without it installed.
 */

type Node = Record<string, unknown> | string;

const GRAY = '#5a6b7b';
const RULE = '#dde3ea';

/** Donut gauge for the overall maturity score. */
export function donutSvg(score: number | null, rating: Rating, size = 150): string {
  const c = size / 2;
  const r = size / 2 - 14;
  const circumference = 2 * Math.PI * r;
  const pct = score === null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const color = ratingColor(rating);
  const label = score === null ? '—' : String(Math.round(score));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#e9edf2" stroke-width="14"/>
<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="14"
 stroke-linecap="round" stroke-dasharray="${(pct * circumference).toFixed(1)} ${circumference.toFixed(1)}"
 transform="rotate(-90 ${c} ${c})"/>
<text x="${c}" y="${c + 2}" text-anchor="middle" font-family="Helvetica, Arial" font-size="${size / 4}" font-weight="bold" fill="#0b2545">${label}</text>
<text x="${c}" y="${c + size / 5.4}" text-anchor="middle" font-family="Helvetica, Arial" font-size="${size / 12}" fill="${GRAY}">of 100</text>
</svg>`;
}

/** Horizontal score bars, one per NIST function. */
export function functionBarsSvg(functions: FunctionScore[], width = 320): string {
  const rowH = 26;
  const barX = 92;
  const barW = width - barX - 44;
  const rows = functions
    .map((f, i) => {
      const y = i * rowH + 6;
      const w = f.score === null ? 0 : Math.max(2, (barW * Math.max(0, Math.min(100, f.score))) / 100);
      const color = ratingColor(f.rating);
      const label = f.score === null ? '—' : String(Math.round(f.score));
      return `<text x="0" y="${y + 12}" font-family="Helvetica, Arial" font-size="10" fill="#0b2545" font-weight="bold">${f.function}</text>
<rect x="${barX}" y="${y}" width="${barW}" height="14" rx="7" fill="#e9edf2"/>
${f.score === null ? '' : `<rect x="${barX}" y="${y}" width="${w.toFixed(1)}" height="14" rx="7" fill="${color}"/>`}
<text x="${barX + barW + 8}" y="${y + 12}" font-family="Helvetica, Arial" font-size="11" fill="#333">${label}</text>`;
    })
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${functions.length * rowH + 8}" viewBox="0 0 ${width} ${functions.length * rowH + 8}">${rows}</svg>`;
}

/** A logo node: data-URI SVGs become svg nodes, rasters become image nodes. */
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
  // pdfmake throws on undecodable images; skip anything that can't be a real
  // raster (truncated uploads) rather than let a bad logo kill the whole PDF.
  if (!/^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]{100,}/.test(dataUri)) return undefined;
  return { image: dataUri, fit: [opts.width ?? 170, opts.height ?? 44], alignment: opts.alignment };
}


/**
 * Trend text safe for the PDF standard fonts (no ▲/▼ — those glyphs aren't in
 * Helvetica's WinAnsi set). The sign + color carry the direction.
 */
function pdfTrend(t: MetricTrend): string {
  if (t.direction === 'na' || t.previous === null) return '';
  if (t.deltaPct === null) return '';
  if (t.direction === 'flat') return 'flat';
  const pct = Math.round(t.deltaPct * 10) / 10;
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

/** Light callout block with an accent left bar (section takeaways, notes). */
function calloutBlock(text: string, accent: string, margin: number[] = [0, 2, 0, 10]): Node {
  return {
    table: {
      widths: [3, '*'],
      body: [
        [
          { text: '', fillColor: accent, border: [false, false, false, false] },
          { text, style: 'body', margin: [8, 6, 8, 6], fillColor: '#f4f7fa', border: [false, false, false, false], color: '#333333' },
        ],
      ],
    },
    layout: { defaultBorder: false, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 },
    margin,
  };
}

function sectionTable(section: ReportSection, brand: BrandTokens): Node {
  const body: unknown[][] = [
    [
      { text: 'Metric', style: 'th' },
      { text: 'This quarter', style: 'th', alignment: 'right' },
      { text: 'vs last', style: 'th', alignment: 'right' },
    ],
    ...section.rows.map(({ metric, trend }) => {
      const t = trend ? pdfTrend(trend) : '';
      const color = trend?.sentiment === 'negative' ? '#c62828' : trend?.sentiment === 'positive' ? '#2e7d32' : GRAY;
      return [
        { text: metric.label, style: 'td' },
        { text: formatValue(metric), style: 'td', alignment: 'right' },
        { text: t, style: 'td', alignment: 'right', color },
      ];
    }),
  ];
  return {
    stack: [
      { text: section.title, style: 'h2', color: brand.primary },
      ...(section.summary ? [calloutBlock(section.summary, brand.accent)] : []),
      {
        table: { headerRows: 1, widths: ['*', 90, 70], body },
        layout: {
          hLineWidth: (i: number) => (i <= 1 ? 1 : 0.5),
          vLineWidth: () => 0,
          hLineColor: (i: number) => (i <= 1 ? brand.accent : RULE),
          // Subtle zebra keeps long tables scannable.
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

/** Priority order for the executive KPI band (first four available win). */
const KPI_CANDIDATES: Array<{ key: string; label: string }> = [
  { key: 'tickets.total', label: 'Tickets handled' },
  { key: 'email.threats_blocked', label: 'Email threats blocked' },
  { key: 'huntress.blocked_malware', label: 'Malware blocked' },
  { key: 'identity.mfa_coverage_pct', label: 'MFA coverage' },
  { key: 'finance.mrr', label: 'Monthly investment' },
  { key: 'endpoints.managed', label: 'Devices managed' },
];

/** The stat band under the executive summary — the quarter at a glance. */
function kpiBand(m: ReportModel): Node | undefined {
  const tiles: Array<{ value: string; label: string; color: string }> = [];
  const score = m.scorecard.overall.score;
  tiles.push({
    value: score === null ? '—' : String(Math.round(score)),
    label: 'Security maturity / 100',
    color: ratingColor(m.scorecard.overall.rating),
  });
  const byKey = new Map(m.sections.flatMap((s) => s.rows.map((r) => [r.metric.key, r.metric] as const)));
  for (const c of KPI_CANDIDATES) {
    if (tiles.length >= 4) break;
    const metric = byKey.get(c.key);
    if (metric && metric.value !== null) tiles.push({ value: formatValue(metric), label: c.label, color: m.brand.primary });
  }
  if (tiles.length < 2) return undefined;
  return {
    table: {
      widths: tiles.map(() => '*'),
      body: [
        tiles.map((t) => ({
          stack: [
            { text: t.value, fontSize: 22, bold: true, color: t.color, alignment: 'center' },
            { text: t.label.toUpperCase(), fontSize: 7.5, color: GRAY, alignment: 'center', characterSpacing: 0.5, margin: [0, 3, 0, 0] },
          ],
          fillColor: '#f4f7fa',
          margin: [4, 10, 4, 10],
        })),
      ],
    },
    layout: {
      defaultBorder: false,
      // White gutters between tiles.
      vLineWidth: () => 3,
      vLineColor: () => '#ffffff',
      hLineWidth: () => 0,
    },
    margin: [0, 4, 0, 14],
  };
}

function discussionTable(items: DiscussionItem[], brand: BrandTokens): Node {
  const body: unknown[][] = [
    [
      { text: 'Discussion / decision', style: 'th' },
      { text: 'Response & notes', style: 'th' },
      { text: 'Outcome', style: 'th' },
    ],
    ...items.map((d) => [
      { text: d.topic, style: 'td', bold: true },
      { text: d.response ?? '—', style: 'td' },
      {
        stack: [
          { text: discussionOutcome(d), style: 'td', color: brand.accent, bold: true },
          ...(d.owner ? [{ text: d.owner, style: 'small' }] : []),
        ],
      },
    ]),
  ];
  return {
    table: { headerRows: 1, widths: ['*', '*', 80], body },
    layout: {
      hLineWidth: (i: number) => (i <= 1 ? 1 : 0.5),
      vLineWidth: () => 0,
      hLineColor: (i: number) => (i <= 1 ? brand.accent : RULE),
      paddingTop: () => 6,
      paddingBottom: () => 6,
      paddingLeft: () => 2,
      paddingRight: () => 2,
    },
  };
}

/** LETTER page geometry (points). */
const PAGE = { width: 612, height: 792 };
const COVER_BAND_H = 132;

function coverPage(m: ReportModel): Node[] {
  const brand = m.brand;
  const logos: Node[] = [];
  const org = logoNode(brand.orgLogoDataUri, { width: 190, height: 48 });
  const client = logoNode(brand.logoDataUri, { width: 150, height: 48, alignment: 'right' });
  if (org && client) logos.push({ columns: [org, client] });
  else if (org) logos.push(org);

  return [
    ...logos,
    { text: '', margin: [0, 96, 0, 0] },
    { canvas: [{ type: 'rect', x: 0, y: 0, w: 90, h: 5, color: brand.accent }] },
    { text: 'QUARTERLY BUSINESS REVIEW', color: brand.accent, fontSize: 14, bold: true, characterSpacing: 2, margin: [0, 14, 0, 6] },
    { text: m.client.name, color: brand.primary, fontSize: 34, bold: true, margin: [0, 0, 0, 6] },
    { text: m.period.label, color: GRAY, fontSize: 17, margin: [0, 0, 0, 26] },
    {
      stack: [
        ...(m.client.primaryContact ? [{ text: [{ text: 'Prepared for  ', color: GRAY }, { text: m.client.primaryContact, bold: true }], margin: [0, 2, 0, 2] as number[] }] : []),
        ...(m.heldBy ? [{ text: [{ text: 'Presented by  ', color: GRAY }, { text: m.heldBy, bold: true }], margin: [0, 2, 0, 2] as number[] }] : []),
        ...(m.generatedLabel ? [{ text: [{ text: 'Date  ', color: GRAY }, { text: m.generatedLabel, bold: true }], margin: [0, 2, 0, 2] as number[] }] : []),
      ],
      fontSize: 11,
    },
    // White text sits inside the brand band the background paints at the foot.
    {
      text: `${m.client.name} · ${m.period.label}`,
      color: '#ffffff',
      fontSize: 13,
      bold: true,
      absolutePosition: { x: 52, y: PAGE.height - COVER_BAND_H + 40 },
    },
    {
      text: `Prepared by ${brand.orgName}${m.client.hipaa ? ' · Contains confidential client information (HIPAA)' : ' · Confidential'}`,
      color: '#ffffff',
      opacity: 0.85,
      fontSize: 9,
      absolutePosition: { x: 52, y: PAGE.height - COVER_BAND_H + 62 },
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

/** Build the full pdfmake document definition (exported for tests). */
export function buildPdfDefinition(m: ReportModel): Record<string, unknown> {
  const brand = m.brand;
  const content: Node[] = [...coverPage(m)];

  // Executive summary — KPI band first, then the narrative.
  if (m.executive.headline || m.executive.paragraphs.length) {
    content.push({ text: 'Executive Summary', style: 'h1', color: brand.primary });
    const band = kpiBand(m);
    if (band) content.push(band);
    if (m.executive.headline) content.push({ text: m.executive.headline, fontSize: 13.5, bold: true, color: brand.accent, margin: [0, 0, 0, 8] });
    for (const p of m.executive.paragraphs) content.push({ text: p, style: 'body' });
    if (m.executive.highlights.length) {
      content.push({ ul: m.executive.highlights.map((h) => ({ text: h, style: 'body', margin: [0, 1, 0, 1] })), margin: [0, 4, 0, 0] });
    }
  }

  // Custom sections placed right after the summary
  for (const cs of m.customSections.filter((s) => s.placement === 'after-summary')) {
    content.push({ text: cs.title, style: 'h2', color: brand.primary });
    for (const p of cs.body.split(/\n\s*\n/).filter(Boolean)) content.push({ text: p.trim(), style: 'body' });
  }

  // Maturity scorecard
  const s = m.scorecard;
  content.push({ text: 'Security & Risk Maturity', style: 'h1', color: brand.primary, pageBreak: 'before' });
  content.push({
    columns: [
      { width: 170, stack: [{ svg: donutSvg(s.overall.score, s.overall.rating), width: 150 }] },
      {
        width: '*',
        stack: [
          { svg: functionBarsSvg(s.functions), width: 320 },
          { text: `${formatPercent(s.overall.coverage * 100)} of safeguards measured · blended CIS Controls v8 / NIST CSF 2.0`, style: 'small', margin: [0, 8, 0, 0] },
        ],
      },
    ],
    columnGap: 18,
    margin: [0, 4, 0, 14],
  });
  // Plain-English explainer so a non-technical reader knows what the score is
  // (and is not) — clients kept asking what "NIST" meant.
  content.push({
    table: {
      widths: ['*'],
      body: [
        [
          {
            stack: [
              { text: 'How to read this score', bold: true, fontSize: 9.5, color: brand.primary, margin: [0, 0, 0, 3] },
              {
                text:
                  'We check the safeguards protecting your business — multi-factor authentication, endpoint protection, patching, backups, and more — against CIS Controls v8, a widely used industry checklist of security best practices. The results are grouped under the six functions of the NIST Cybersecurity Framework (Govern, Identify, Protect, Detect, Respond, Recover) so you can see at a glance where your defenses are strong and where we recommend investment. The score reflects what our connected tools can measure this quarter — it is a posture guide, not a compliance certification.' +
                  (m.client.complianceStandard
                    ? ` Because ${m.client.name} answers to ${m.client.complianceStandard}, we weigh these findings with ${m.client.complianceStandard} expectations in mind throughout this review.`
                    : ''),
                fontSize: 8.5,
                color: GRAY,
                lineHeight: 1.25,
              },
            ],
            fillColor: '#f4f6f8',
            margin: [10, 8, 10, 8],
          },
        ],
      ],
    },
    layout: 'noBorders',
    margin: [0, 0, 0, 14],
  });
  if (s.remediations.length) {
    content.push({ text: 'Priority remediations', style: 'h2', color: brand.primary });
    content.push({
      ul: s.remediations.map((r) => ({ text: [{ text: `${r.title} — `, bold: true }, { text: r.evidence }], style: 'body', margin: [0, 1, 0, 1] })),
    });
  }

  // Metric sections
  if (m.sections.length) {
    content.push({ text: 'Quarter in Numbers', style: 'h1', color: brand.primary, pageBreak: 'before' });
    for (const section of m.sections) content.push(sectionTable(section, brand));
  }

  // In-body custom sections
  for (const cs of m.customSections.filter((c) => (c.placement ?? 'in-body') === 'in-body')) {
    content.push({ text: cs.title, style: 'h2', color: brand.primary });
    for (const p of cs.body.split(/\n\s*\n/).filter(Boolean)) content.push({ text: p.trim(), style: 'body' });
  }

  // Discussion & decisions from the meeting
  if (m.discussion.length || m.notes) {
    content.push({ text: 'Discussion & Decisions', style: 'h1', color: brand.primary, pageBreak: 'before' });
    if (m.discussion.length) content.push(discussionTable(m.discussion, brand));
    if (m.notes) {
      content.push({ text: 'Meeting notes', style: 'h2', color: brand.primary, margin: [0, 14, 0, 4] });
      content.push({ text: m.notes, style: 'body', italics: true });
    }
  }

  // Recommendations
  if (m.recommendations.length) {
    content.push({ text: 'Recommendations & Next 90 Days', style: 'h1', color: brand.primary, pageBreak: 'before' });
    content.push({ ol: m.recommendations.map((r) => ({ text: r, style: 'body', margin: [0, 2, 0, 2] })) });
  }

  // End-placed custom sections
  for (const cs of m.customSections.filter((c) => c.placement === 'end')) {
    content.push({ text: cs.title, style: 'h2', color: brand.primary });
    for (const p of cs.body.split(/\n\s*\n/).filter(Boolean)) content.push({ text: p.trim(), style: 'body' });
  }

  // Appendix: attached vendor reports
  if (m.documents.length) {
    content.push({ text: 'Appendix — Attached Reports', style: 'h1', color: brand.primary, pageBreak: 'before' });
    content.push({ text: 'The following source reports accompany this review:', style: 'body' });
    content.push({
      ul: m.documents.map((d) => ({ text: [{ text: d.name, bold: true }, { text: `  (${d.source})`, color: GRAY }], style: 'body', margin: [0, 1, 0, 1] })),
    });
  }

  return {
    content,
    pageSize: 'LETTER',
    pageMargins: [52, 58, 52, 56],
    background: pageBackground(brand),
    info: { title: `${m.client.name} — ${m.period.label} QBR`, author: brand.orgName },
    defaultStyle: { font: 'Helvetica', fontSize: 10.5, color: brand.ink, lineHeight: 1.3 },
    styles: {
      h1: { fontSize: 19, bold: true, margin: [0, 0, 0, 10] },
      h2: { fontSize: 13, bold: true, margin: [0, 10, 0, 6] },
      th: { fontSize: 8.5, bold: true, color: GRAY, characterSpacing: 0.4 },
      td: { fontSize: 10 },
      body: { fontSize: 10.5, margin: [0, 0, 0, 6] },
      small: { fontSize: 8.5, color: GRAY },
    },
    header: (page: number) =>
      page === 1
        ? undefined
        : {
            columns: [
              { text: `${brand.orgName} · Quarterly Business Review`, color: GRAY, fontSize: 8 },
              { text: `${m.client.name} — ${m.period.label}`, color: GRAY, fontSize: 8, alignment: 'right' },
            ],
            margin: [52, 24, 52, 0],
          },
    footer: (page: number, pages: number) => ({
      columns: [
        { text: `Prepared by ${brand.orgName} — confidential`, color: GRAY, fontSize: 8 },
        { text: `Page ${page} of ${pages}`, color: GRAY, fontSize: 8, alignment: 'right' },
      ],
      margin: [52, 18, 52, 0],
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
  // The PDF standard 14 fonts ship inside every reader — nothing to embed.
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
    // A corrupt uploaded logo must not block the deliverable — retry without logos.
    if (e instanceof Error && /image/i.test(e.message)) {
      const stripped = { ...model, brand: { ...model.brand, logoDataUri: undefined, orgLogoDataUri: '' } };
      return render(buildPdfDefinition(stripped));
    }
    throw e;
  }
}
