import type { DiscussionItem, MetricTrend } from '@mashit/core';
import { ratingColor } from './format.js';
import { formatValue } from './format.js';
import type { ReportModel, ReportSection } from './model.js';

/**
 * The meeting PowerPoint deck, rebuilt for presentation quality:
 * - a slide master (brand footer bar + slide numbers) instead of naked slides
 * - every text box carries explicit x/y/w/h + valign so nothing overlaps
 *   (pptxgenjs default-sizes unbounded boxes into each other — the old bug)
 * - native, editable charts (doughnut score, radar functions, QoQ bars)
 * - reads model.brand: colors, the Mash IT logo, and the client logo
 * pptxgenjs is imported dynamically so the package builds/tests without it.
 */

const hex = (c: string) => c.replace('#', '').toUpperCase();
const GRAY = '5A6B7B';
const LIGHT = 'E9EDF2';

/** Slide geometry (13.333 × 7.5 WIDE layout). */
const PAGE_W = 13.333;
const CONTENT_X = 0.6;
const CONTENT_W = PAGE_W - 2 * CONTENT_X;
const TITLE_Y = 0.42;
const BODY_Y = 1.35;
const FOOTER_Y = 7.08;

export async function renderDeck(model: ReportModel): Promise<Buffer> {
  const spec = 'pptxgenjs';
  let mod: any;
  try {
    mod = await import(spec);
  } catch {
    throw new Error("renderDeck requires the optional 'pptxgenjs' dependency. Install it to enable deck export.");
  }
  const PptxGenJS = mod.default ?? mod;
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: PAGE_W, height: 7.5 });
  pptx.layout = 'WIDE';

  const brand = model.brand;
  const PRIMARY = hex(brand.primary);
  const ACCENT = hex(brand.accent);
  const FONT = 'Segoe UI';

  pptx.author = brand.orgName;
  pptx.title = `${model.client.name} — ${model.period.label} QBR`;

  // Master with the brand footer bar + slide number; title slide stays clean.
  pptx.defineSlideMaster({
    title: 'QBR',
    background: { color: 'FFFFFF' },
    objects: [
      { rect: { x: 0, y: FOOTER_Y, w: PAGE_W, h: 7.5 - FOOTER_Y, fill: { color: PRIMARY } } },
      {
        text: {
          text: `${brand.orgName} · Quarterly Business Review · ${model.client.name} · ${model.period.label}`,
          options: { x: CONTENT_X, y: FOOTER_Y, w: 10, h: 7.5 - FOOTER_Y, fontFace: FONT, fontSize: 9, color: 'FFFFFF', valign: 'middle', align: 'left' },
        },
      },
    ],
    slideNumber: { x: 12.55, y: FOOTER_Y + 0.06, w: 0.6, h: 0.3, color: 'FFFFFF', fontFace: FONT, fontSize: 9 },
  });
  pptx.defineSlideMaster({ title: 'TITLE', background: { color: 'FFFFFF' } });

  const heading = (slide: any, text: string) => {
    slide.addText(text, {
      x: CONTENT_X,
      y: TITLE_Y,
      w: CONTENT_W,
      h: 0.55,
      fontFace: FONT,
      fontSize: 26,
      color: PRIMARY,
      bold: true,
      valign: 'top',
    });
    slide.addShape('rect', { x: CONTENT_X, y: TITLE_Y + 0.62, w: 1.1, h: 0.05, fill: { color: ACCENT }, line: { type: 'none' } });
  };

  const logo = (slide: any, dataUri: string | undefined, opts: { x: number; y: number; w: number; h: number }) => {
    if (!dataUri) return;
    try {
      slide.addImage({ data: dataUri, x: opts.x, y: opts.y, w: opts.w, h: opts.h, sizing: { type: 'contain', w: opts.w, h: opts.h } });
    } catch {
      // A malformed logo must never break deck generation.
    }
  };

  // ── Title slide ─────────────────────────────────────────────────────────
  {
    const s = pptx.addSlide({ masterName: 'TITLE' });
    s.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: 0.22, fill: { color: ACCENT }, line: { type: 'none' } });
    logo(s, brand.orgLogoDataUri, { x: CONTENT_X, y: 0.55, w: 2.8, h: 0.62 });
    logo(s, brand.logoDataUri, { x: PAGE_W - CONTENT_X - 2.2, y: 0.55, w: 2.2, h: 0.62 });

    s.addShape('rect', { x: CONTENT_X, y: 2.6, w: 0.12, h: 2.15, fill: { color: ACCENT }, line: { type: 'none' } });
    s.addText('QUARTERLY BUSINESS REVIEW', {
      x: 0.95, y: 2.65, w: 9, h: 0.45, fontFace: FONT, fontSize: 16, color: ACCENT, bold: true, charSpacing: 2, valign: 'top',
    });
    s.addText(model.client.name, { x: 0.95, y: 3.1, w: 11.6, h: 1.15, fontFace: FONT, fontSize: 42, color: PRIMARY, bold: true, valign: 'top', fit: 'shrink' });
    s.addText(model.period.label + (model.heldBy ? `   ·   Presented by ${model.heldBy}` : ''), {
      x: 0.95, y: 4.25, w: 11, h: 0.5, fontFace: FONT, fontSize: 16, color: GRAY, valign: 'top',
    });
    if (model.generatedLabel) {
      s.addText(model.generatedLabel, { x: 0.95, y: 4.75, w: 8, h: 0.4, fontFace: FONT, fontSize: 12, color: GRAY, valign: 'top' });
    }
    s.addText(`Prepared by ${brand.orgName} — confidential`, {
      x: CONTENT_X, y: 6.9, w: 8, h: 0.35, fontFace: FONT, fontSize: 10, color: GRAY, valign: 'top',
    });
  }

  // ── Executive summary ───────────────────────────────────────────────────
  if (model.executive.headline || model.executive.paragraphs.length || model.executive.highlights.length) {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, 'Executive Summary');
    let y = BODY_Y;
    if (model.executive.headline) {
      s.addText(model.executive.headline, { x: CONTENT_X, y, w: CONTENT_W, h: 0.75, fontFace: FONT, fontSize: 16, color: ACCENT, bold: true, valign: 'top', fit: 'shrink' });
      y += 0.85;
    }
    const bullets = [...model.executive.paragraphs, ...model.executive.highlights].map((t) => ({
      text: t,
      options: { bullet: { code: '2022' }, color: '222222' },
    }));
    if (bullets.length) {
      s.addText(bullets, {
        x: CONTENT_X, y, w: CONTENT_W, h: FOOTER_Y - 0.2 - y, fontFace: FONT, fontSize: 13, valign: 'top', fit: 'shrink', paraSpaceAfter: 8,
      });
    }
  }

  // ── Maturity scorecard: doughnut + radar ────────────────────────────────
  {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, 'Security & Risk Maturity');
    const sc = model.scorecard;
    const score = sc.overall.score;
    const scoreColor = hex(ratingColor(sc.overall.rating));

    s.addChart(pptx.ChartType.doughnut, [{ name: 'Maturity', labels: ['Score', 'Gap'], values: [score ?? 0, 100 - (score ?? 0)] }], {
      x: CONTENT_X, y: BODY_Y + 0.15, w: 3.6, h: 3.6,
      holeSize: 72,
      chartColors: [scoreColor, LIGHT],
      showLegend: false,
      showValue: false,
      showTitle: false,
    });
    s.addText(score === null ? '—' : String(Math.round(score)), {
      x: CONTENT_X + 0.8, y: BODY_Y + 1.35, w: 2.0, h: 0.9, fontFace: FONT, fontSize: 40, bold: true, color: PRIMARY, align: 'center', valign: 'middle',
    });
    s.addText(`of 100 · ${sc.overall.rating.toUpperCase()}`, {
      x: CONTENT_X + 0.8, y: BODY_Y + 2.2, w: 2.0, h: 0.35, fontFace: FONT, fontSize: 11, color: GRAY, align: 'center', valign: 'top',
    });
    s.addText(`${Math.round(sc.overall.coverage * 100)}% of safeguards measured — blended CIS Controls v8 / NIST CSF 2.0`, {
      x: CONTENT_X, y: BODY_Y + 4.0, w: 4.0, h: 0.9, fontFace: FONT, fontSize: 10, color: GRAY, valign: 'top',
    });

    const fns = sc.functions;
    s.addChart(
      pptx.ChartType.radar,
      [{ name: 'Maturity', labels: fns.map((f) => f.function), values: fns.map((f) => f.score ?? 0) }],
      {
        x: 5.4, y: BODY_Y + 0.05, w: 7.2, h: 4.9,
        radarStyle: 'filled',
        chartColors: [ACCENT],
        chartColorsOpacity: 35,
        showLegend: false,
        valAxisMaxVal: 100,
        valAxisMinVal: 0,
        catAxisLabelColor: PRIMARY,
        catAxisLabelFontFace: FONT,
        catAxisLabelFontSize: 11,
        valAxisLabelFontSize: 8,
        valAxisLabelColor: GRAY,
      },
    );
  }

  // ── Quarter-over-quarter movers (native bar chart) ──────────────────────
  const movers = pickMovers(model.trends);
  if (movers.length >= 2) {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, 'Quarter over Quarter');
    s.addChart(
      pptx.ChartType.bar,
      [
        { name: model.previousPeriod?.label ?? 'Previous', labels: movers.map((t) => t.label), values: movers.map((t) => t.previous ?? 0) },
        { name: model.period.label, labels: movers.map((t) => t.label), values: movers.map((t) => t.current ?? 0) },
      ],
      {
        x: CONTENT_X, y: BODY_Y, w: CONTENT_W, h: 5.1,
        barDir: 'col',
        chartColors: [LIGHT.toLowerCase() === 'e9edf2' ? 'B9C4CF' : LIGHT, ACCENT],
        showLegend: true,
        legendPos: 'b',
        legendFontFace: FONT,
        catAxisLabelFontFace: FONT,
        catAxisLabelFontSize: 10,
        valAxisLabelFontSize: 9,
        dataLabelFontFace: FONT,
        showValue: true,
        dataLabelFontSize: 9,
        dataLabelColor: '333333',
      },
    );
  }

  // ── One slide per metric section (styled, auto-paging tables) ───────────
  for (const section of model.sections) {
    addSectionSlides(pptx, section, { PRIMARY, ACCENT, FONT, heading });
  }

  // ── Client-authored custom sections ─────────────────────────────────────
  for (const cs of model.customSections) {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, cs.title);
    s.addText(cs.body, { x: CONTENT_X, y: BODY_Y, w: CONTENT_W, h: FOOTER_Y - 0.2 - BODY_Y, fontFace: FONT, fontSize: 13, color: '222222', valign: 'top', fit: 'shrink' });
  }

  // ── Discussion & decisions ──────────────────────────────────────────────
  if (model.discussion.length || model.notes) {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, 'Discussion & Decisions');
    if (model.discussion.length) {
      const rows = [
        ['Discussion / decision', 'Response & notes', 'Outcome'].map((t) => ({
          text: t,
          options: { bold: true, color: 'FFFFFF', fill: { color: PRIMARY }, fontFace: FONT, fontSize: 11 },
        })),
        ...model.discussion.map((d: DiscussionItem) => [
          { text: d.topic, options: { fontFace: FONT, fontSize: 11, bold: true } },
          { text: d.response ?? '—', options: { fontFace: FONT, fontSize: 11 } },
          { text: dispositionLabel(d), options: { fontFace: FONT, fontSize: 11, color: ACCENT, bold: true } },
        ]),
      ];
      s.addTable(rows, {
        x: CONTENT_X, y: BODY_Y, w: CONTENT_W,
        colW: [4.4, 5.6, 2.13],
        border: { type: 'solid', color: 'DDE3EA', pt: 0.5 },
        valign: 'top',
        autoPage: true,
        autoPageRepeatHeader: true,
        newSlideStartY: BODY_Y,
      });
    } else if (model.notes) {
      s.addText(model.notes, { x: CONTENT_X, y: BODY_Y, w: CONTENT_W, h: 4.5, fontFace: FONT, fontSize: 12, color: '444444', italic: true, valign: 'top', fit: 'shrink' });
    }
  }

  // ── Recommendations / next 90 days ──────────────────────────────────────
  if (model.recommendations.length) {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, 'Recommendations & Next 90 Days');
    s.addText(
      model.recommendations.map((t, i) => ({ text: t, options: { bullet: { code: '2022' }, color: '222222', paraSpaceAfter: i === model.recommendations.length - 1 ? 0 : 10 } })),
      { x: CONTENT_X, y: BODY_Y, w: CONTENT_W, h: FOOTER_Y - 0.2 - BODY_Y, fontFace: FONT, fontSize: 14, valign: 'top', fit: 'shrink' },
    );
  }

  // ── Thank-you / contact ─────────────────────────────────────────────────
  {
    const s = pptx.addSlide({ masterName: 'TITLE' });
    s.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: 7.5, fill: { color: PRIMARY }, line: { type: 'none' } });
    s.addText('Thank you', { x: CONTENT_X, y: 2.9, w: 8, h: 0.9, fontFace: FONT, fontSize: 40, color: 'FFFFFF', bold: true, valign: 'top' });
    s.addText(`${brand.orgName} — your IT partner`, { x: CONTENT_X, y: 3.85, w: 9, h: 0.5, fontFace: FONT, fontSize: 16, color: hex(brand.accent), valign: 'top' });
  }

  const out = await pptx.write({ outputType: 'nodebuffer' });
  return out as Buffer;
}

function dispositionLabel(d: DiscussionItem): string {
  const labels: Record<string, string> = {
    pending: 'Pending',
    create_opportunity: 'Opportunity',
    create_ticket: 'Ticket',
    accept_risk: 'Accept risk',
    no_action: 'No action',
  };
  if (d.disposition) return labels[d.disposition] ?? d.disposition;
  return d.status === 'discussed' ? 'Discussed' : 'Planned';
}

// Telemetry-volume metrics (SIEM events, log counts) dwarf everything else on
// a shared axis and aren't executive QoQ material anyway.
const QOQ_EXCLUDE = /siem|logs|events|signals/i;
const QOQ_MAX_MAGNITUDE = 100_000;

/** The most meaningful QoQ movers: numeric both quarters, biggest % change first. */
export function pickMovers(trends: MetricTrend[], max = 6): MetricTrend[] {
  return trends
    .filter(
      (t) =>
        t.current !== null &&
        t.previous !== null &&
        t.deltaPct !== null &&
        t.previous !== 0 &&
        !QOQ_EXCLUDE.test(t.key) &&
        Math.abs(t.current) < QOQ_MAX_MAGNITUDE &&
        Math.abs(t.previous) < QOQ_MAX_MAGNITUDE,
    )
    .sort((a, b) => Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0))
    .slice(0, max);
}

/** Section slide with a styled table (auto-pages over extra slides when long). */
function addSectionSlides(
  pptx: any,
  section: ReportSection,
  t: { PRIMARY: string; ACCENT: string; FONT: string; heading: (slide: any, text: string) => void },
): void {
  const s = pptx.addSlide({ masterName: 'QBR' });
  t.heading(s, section.title);
  let tableY = BODY_Y;
  if (section.summary) {
    s.addText(section.summary, {
      x: CONTENT_X, y: BODY_Y, w: CONTENT_W, h: 0.6,
      fontFace: t.FONT, fontSize: 13, italic: true, color: '444444', valign: 'top', fit: 'shrink',
    });
    tableY = BODY_Y + 0.7;
  }
  const rows = [
    ['Metric', 'This quarter', 'vs last'].map((text) => ({
      text,
      options: { bold: true, color: 'FFFFFF', fill: { color: t.PRIMARY }, fontFace: t.FONT, fontSize: 11 },
    })),
    ...section.rows.map(({ metric, trend }) => {
      const delta = trend && trend.previous !== null && trend.deltaPct !== null ? `${trend.deltaPct > 0 ? '+' : ''}${trend.deltaPct}%` : '';
      const deltaColor = trend?.sentiment === 'negative' ? 'C62828' : trend?.sentiment === 'positive' ? '2E7D32' : '5A6B7B';
      return [
        { text: metric.label, options: { fontFace: t.FONT, fontSize: 11 } },
        { text: formatValue(metric), options: { fontFace: t.FONT, fontSize: 11, align: 'right', bold: true } },
        { text: delta, options: { fontFace: t.FONT, fontSize: 11, align: 'right', color: deltaColor } },
      ];
    }),
  ];
  s.addTable(rows, {
    x: CONTENT_X, y: tableY, w: CONTENT_W,
    colW: [7.6, 2.6, 1.93],
    border: { type: 'solid', color: 'DDE3EA', pt: 0.5 },
    valign: 'top',
    autoPage: true,
    autoPageRepeatHeader: true,
    newSlideStartY: BODY_Y,
  });
}
