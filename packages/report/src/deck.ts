import type { DiscussionItem, MetricTrend } from '@mashit/core';
import { discussionOutcome, ratingColor, ratingWord, trendDeltaText, goalStatusLabel, goalStatusColor, SEMANTIC } from './format.js';
import { formatValue } from './format.js';
import { imageDims } from './images.js';
import type { ReportModel, ReportSection } from './model.js';

export { imageDims } from './images.js';

/**
 * The meeting PowerPoint deck, rebuilt for presentation quality:
 * - a slide master (brand footer bar + slide numbers) instead of naked slides
 * - every text box carries explicit x/y/w/h + valign so nothing overlaps
 * - native, editable charts (doughnut score, radar functions, QoQ bars)
 * - reads model.brand: colors, the Mash IT logo, and the client logo
 * - every table is paged by hand into titled slides; pptxgenjs autoPage
 *   creates untitled continuation slides, so it is never used
 * pptxgenjs is imported dynamically so the package builds/tests without it.
 */

const hex = (c: string) => c.replace('#', '').toUpperCase();

const GRAY = hex(SEMANTIC.muted);
const TEXT = hex(SEMANTIC.text);
const LIGHT = hex(SEMANTIC.unknownBg);
const RULE = hex(SEMANTIC.hairline);

/** Slide geometry (13.333 × 7.5 WIDE layout). */
const PAGE_W = 13.333;
const CONTENT_X = 0.6;
const CONTENT_W = PAGE_W - 2 * CONTENT_X;
const TITLE_Y = 0.42;
const BODY_Y = 1.35;
const FOOTER_Y = 7.08;

/** Human names for the NIST CSF 2.0 functions. */
const FUNCTION_NAME: Record<string, string> = {
  GOVERN: 'Govern',
  IDENTIFY: 'Identify',
  PROTECT: 'Protect',
  DETECT: 'Detect',
  RESPOND: 'Respond',
  RECOVER: 'Recover',
};

type Theme = {
  PRIMARY: string;
  ACCENT: string;
  FONT: string;
  heading: (slide: any, text: string) => void;
  notes: (slide: any, text: string) => void;
};

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
  pptx.title = `${model.client.name} QBR, ${model.period.label}`;

  // Master with the brand footer bar + slide number; title slide stays clean.
  pptx.defineSlideMaster({
    title: 'QBR',
    background: { color: 'FFFFFF' },
    objects: [
      { rect: { x: 0, y: FOOTER_Y, w: PAGE_W, h: 7.5 - FOOTER_Y, fill: { color: PRIMARY } } },
      {
        text: {
          text: `${brand.orgName} quarterly business review for ${model.client.name}, ${model.period.label}`,
          options: { x: CONTENT_X, y: FOOTER_Y, w: 10, h: 7.5 - FOOTER_Y, fontFace: FONT, fontSize: 9, color: 'FFFFFF', valign: 'middle', align: 'left' },
        },
      },
    ],
    slideNumber: { x: 12.55, y: FOOTER_Y + 0.06, w: 0.6, h: 0.3, color: 'FFFFFF', fontFace: FONT, fontSize: 9 },
  });
  pptx.defineSlideMaster({ title: 'TITLE', background: { color: 'FFFFFF' } });

  // Speaker notes turn each slide into something you can actually present from:
  // the detail lives here so the slide can stay clean.
  const notes = (slide: any, text: string) => {
    const t = text.trim();
    if (t) slide.addNotes(t);
  };

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
  const theme: Theme = { PRIMARY, ACCENT, FONT, heading, notes };

  // pptxgenjs can't read intrinsic dimensions out of a data URI, so its
  // "contain" sizing stretches logos into the box. Compute the aspect-correct
  // placement ourselves and anchor it to the box's edge.
  const logo = (
    slide: any,
    dataUri: string | undefined,
    opts: { x: number; y: number; w: number; h: number; anchor?: 'left' | 'right' },
  ) => {
    if (!dataUri) return;
    try {
      const dims = imageDims(dataUri);
      let { w, h } = opts;
      let { x, y } = opts;
      if (dims) {
        const scale = Math.min(opts.w / dims.w, opts.h / dims.h);
        w = dims.w * scale;
        h = dims.h * scale;
        if (opts.anchor === 'right') x = opts.x + opts.w - w;
        y = opts.y + (opts.h - h) / 2;
      }
      slide.addImage({ data: dataUri, x, y, w, h });
    } catch {
      // A malformed logo must never break deck generation.
    }
  };

  // ── Title slide ─────────────────────────────────────────────────────────
  {
    const s = pptx.addSlide({ masterName: 'TITLE' });
    s.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: 0.22, fill: { color: ACCENT }, line: { type: 'none' } });
    logo(s, brand.orgLogoDataUri, { x: CONTENT_X, y: 0.42, w: 2.8, h: 0.78, anchor: 'left' });
    if (brand.tagline) {
      s.addText(brand.tagline, { x: CONTENT_X, y: 1.24, w: 4, h: 0.3, fontFace: FONT, fontSize: 10, color: GRAY, valign: 'top' });
    }
    // Client logo sits larger (often a small square next to a wide wordmark).
    logo(s, brand.logoDataUri, { x: PAGE_W - CONTENT_X - 2.4, y: 0.3, w: 2.4, h: 1.2, anchor: 'right' });

    s.addShape('rect', { x: CONTENT_X, y: 2.6, w: 0.12, h: 2.15, fill: { color: ACCENT }, line: { type: 'none' } });
    s.addText('Quarterly business review', {
      x: 0.95, y: 2.65, w: 9, h: 0.45, fontFace: FONT, fontSize: 16, color: ACCENT, bold: true, valign: 'top',
    });
    s.addText(model.client.name, { x: 0.95, y: 3.1, w: 11.6, h: 1.15, fontFace: FONT, fontSize: 42, color: PRIMARY, bold: true, valign: 'top', fit: 'shrink' });
    s.addText(model.period.label, { x: 0.95, y: 4.25, w: 11, h: 0.5, fontFace: FONT, fontSize: 16, color: GRAY, valign: 'top' });
    const byline = [model.heldBy ? `Presented by ${model.heldBy}` : '', model.generatedLabel ?? ''].filter(Boolean).join('. ');
    if (byline) {
      s.addText(byline, { x: 0.95, y: 4.75, w: 8, h: 0.4, fontFace: FONT, fontSize: 12, color: GRAY, valign: 'top' });
    }
    s.addText(`Prepared by ${brand.orgName}. Confidential.`, {
      x: CONTENT_X, y: 6.9, w: 8, h: 0.35, fontFace: FONT, fontSize: 10, color: GRAY, valign: 'top',
    });
    notes(
      s,
      `Open the meeting: thank ${model.client.primaryContact ?? 'the client'} for their time and set the agenda: this quarter's results, security posture, what needs a decision, and where we go next. Keep it conversational; the slides are a backdrop for the discussion.`,
    );
  }

  // ── Executive summary ───────────────────────────────────────────────────
  if (model.executive.headline || model.executive.paragraphs.length || model.executive.highlights.length) {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, 'Executive Summary');
    let y = BODY_Y;
    if (model.executive.headline) {
      s.addText(model.executive.headline, { x: CONTENT_X, y, w: CONTENT_W, h: 0.85, fontFace: FONT, fontSize: 18, color: PRIMARY, bold: true, valign: 'top', fit: 'shrink' });
      y += 1.0;
    }
    // The slide shows a few crisp talking points (highlights, or a first
    // sentence per paragraph), never the full prose, which overflowed the
    // page. The complete narrative goes into the speaker notes below.
    const points = (model.executive.highlights.length ? model.executive.highlights : model.executive.paragraphs.map(firstSentence)).slice(0, 5);
    const confidenceH = model.dataConfidence.length ? 0.9 : 0;
    if (points.length) {
      s.addText(
        points.map((t, i) => ({ text: t, options: { bullet: { code: '2022' }, color: TEXT, paraSpaceAfter: i === points.length - 1 ? 0 : 12 } })),
        { x: CONTENT_X, y, w: CONTENT_W, h: FOOTER_Y - 0.2 - y - confidenceH, fontFace: FONT, fontSize: 16, valign: 'top', fit: 'shrink' },
      );
    }
    if (model.dataConfidence.length) {
      s.addShape('rect', {
        x: CONTENT_X, y: FOOTER_Y - 0.2 - confidenceH, w: CONTENT_W, h: confidenceH - 0.1,
        fill: { color: hex(SEMANTIC.watchBg) }, line: { type: 'none' },
      });
      s.addText(
        [
          { text: 'Data confidence: ', options: { bold: true, color: hex(SEMANTIC.watch) } },
          { text: model.dataConfidence.join(' '), options: { color: TEXT } },
        ],
        { x: CONTENT_X + 0.15, y: FOOTER_Y - 0.2 - confidenceH, w: CONTENT_W - 0.3, h: confidenceH - 0.1, fontFace: FONT, fontSize: 10, valign: 'middle', fit: 'shrink' },
      );
    }
    notes(
      s,
      [
        model.executive.headline,
        '',
        ...model.executive.paragraphs,
        ...(model.executive.highlights.length ? ['', 'Highlights:', ...model.executive.highlights.map((h) => `• ${h}`)] : []),
        ...(model.dataConfidence.length ? ['', 'Data confidence (say this out loud before the numbers):', ...model.dataConfidence.map((w) => `• ${w}`)] : []),
      ]
        .filter((l) => l !== undefined)
        .join('\n'),
    );
  }

  // ── Strategic goals & IT alignment ──────────────────────────────────────
  if (model.goals.length) {
    const header = ['Goal', 'How we support it', 'Status'];
    const rows = model.goals.map((g) => [
      { text: g.targetPeriod ? `${g.title}\n(target ${g.targetPeriod})` : g.title, options: { fontFace: FONT, fontSize: 11, bold: true } },
      { text: g.alignment ?? 'Not described yet', options: { fontFace: FONT, fontSize: 11 } },
      { text: goalStatusLabel(g.status), options: { fontFace: FONT, fontSize: 11, bold: true, color: 'FFFFFF', fill: { color: hex(goalStatusColor(g.status)) } } },
    ]);
    addTableSlides(pptx, theme, {
      title: 'Strategic Goals & IT Alignment',
      header,
      rows,
      colW: [4.4, 5.6, 2.13],
      rowsPerSlide: 6,
      notes: `Tie the quarter's work back to what the client is trying to achieve. Walk each goal, confirm the status is still right, and ask what's changed on their side. Goals: ${model.goals
        .map((g) => `${g.title} (${goalStatusLabel(g.status)})`)
        .join('; ')}.`,
    });
  }

  // ── Maturity scorecard: doughnut + radar ────────────────────────────────
  {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, 'Security & Risk Maturity');
    const sc = model.scorecard;
    const { score, rating, coverage, confidence } = sc.overall;
    const withheld = score === null || confidence === 'low';
    const coverageText = `${Math.round(coverage * 100)}% of the controls we check could be measured this quarter`;

    if (withheld) {
      s.addText('Not scored', {
        x: CONTENT_X, y: BODY_Y + 0.3, w: 4.0, h: 0.7, fontFace: FONT, fontSize: 28, bold: true, color: GRAY, valign: 'top',
      });
      s.addText(`Not enough security data to score this quarter. Only ${coverageText}. Connecting the remaining tools lets the score appear next quarter; nothing here is a failing grade.`, {
        x: CONTENT_X, y: BODY_Y + 1.1, w: 4.2, h: 2.4, fontFace: FONT, fontSize: 12, color: TEXT, valign: 'top',
      });
    } else {
      const scoreColor = hex(ratingColor(rating));
      s.addChart(pptx.ChartType.doughnut, [{ name: 'Maturity', labels: ['Score', 'Gap'], values: [score, 100 - score] }], {
        x: CONTENT_X, y: BODY_Y + 0.15, w: 3.6, h: 3.6,
        holeSize: 72,
        chartColors: [scoreColor, LIGHT],
        showLegend: false,
        showValue: false,
        showTitle: false,
      });
      s.addText(String(Math.round(score)), {
        x: CONTENT_X + 0.8, y: BODY_Y + 1.35, w: 2.0, h: 0.9, fontFace: FONT, fontSize: 40, bold: true, color: PRIMARY, align: 'center', valign: 'middle',
      });
      s.addText(`of 100, ${ratingWord(rating)}${confidence === 'medium' ? ', provisional' : ''}`, {
        x: CONTENT_X + 0.5, y: BODY_Y + 2.2, w: 2.6, h: 0.35, fontFace: FONT, fontSize: 11, color: GRAY, align: 'center', valign: 'top',
      });
      s.addText(`${coverageText}. Blended CIS Controls v8 and NIST CSF 2.0.`, {
        x: CONTENT_X, y: BODY_Y + 4.0, w: 4.0, h: 0.9, fontFace: FONT, fontSize: 10, color: GRAY, valign: 'top',
      });
    }

    // Unmeasured functions must not chart as 0: with sparse data a radar
    // collapses into misleading spikes, so switch to horizontal bars.
    const fns = sc.functions.filter((f) => f.score !== null);
    const missing = sc.functions.filter((f) => f.score === null).map((f) => FUNCTION_NAME[f.function] ?? f.function);
    if (fns.length >= 3) {
      s.addChart(
        pptx.ChartType.radar,
        [{ name: 'Maturity', labels: fns.map((f) => FUNCTION_NAME[f.function] ?? f.function), values: fns.map((f) => f.score ?? 0) }],
        {
          x: 5.4, y: BODY_Y + 0.05, w: 7.2, h: 4.5,
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
      if (missing.length) {
        s.addText(`Not measured this quarter: ${missing.join(', ')}.`, {
          x: 5.4, y: BODY_Y + 4.6, w: 7.2, h: 0.4, fontFace: FONT, fontSize: 10, color: GRAY, valign: 'top',
        });
      }
    } else if (fns.length > 0) {
      s.addChart(
        pptx.ChartType.bar,
        [{ name: 'Maturity', labels: fns.map((f) => FUNCTION_NAME[f.function] ?? f.function), values: fns.map((f) => f.score ?? 0) }],
        {
          x: 5.4, y: BODY_Y + 0.3, w: 7.2, h: 1.0 + fns.length * 0.8,
          barDir: 'bar',
          chartColors: [ACCENT],
          showLegend: false,
          valAxisMaxVal: 100,
          valAxisMinVal: 0,
          catAxisLabelFontFace: FONT,
          catAxisLabelFontSize: 11,
          catAxisLabelColor: PRIMARY,
          valAxisLabelFontSize: 8,
          valAxisLabelColor: GRAY,
          dataLabelColor: PRIMARY,
          showValue: true,
        },
      );
      if (missing.length) {
        s.addText(`Not measured this quarter: ${missing.join(', ')}.`, {
          x: 5.4, y: BODY_Y + 1.5 + fns.length * 0.8, w: 7.2, h: 0.4, fontFace: FONT, fontSize: 10, color: GRAY, valign: 'top',
        });
      }
    } else {
      s.addText('No security functions could be measured this quarter.', {
        x: 5.4, y: BODY_Y + 0.3, w: 7.2, h: 0.6, fontFace: FONT, fontSize: 12, color: GRAY, valign: 'top',
      });
    }
    const weakest = sc.functions.filter((f) => f.score !== null).sort((a, b) => (a.score ?? 0) - (b.score ?? 0)).slice(0, 2);
    notes(
      s,
      `Explain the score in plain terms: it blends the security safeguards we can measure (MFA, endpoint protection, patching, backups) against an industry checklist, grouped under the NIST framework. It's a posture guide, not a compliance audit. Overall ${
        withheld ? 'not yet scored; say why (coverage) and what connecting the remaining tools unlocks' : `${Math.round(score)}/100 (${ratingWord(rating)})`
      }.${weakest.length ? ` Point the conversation at where to invest next: ${weakest.map((f) => FUNCTION_NAME[f.function] ?? f.function).join(' and ')}.` : ''}`,
    );
  }

  // ── Service desk, quarter over quarter (coherent ticket counts only) ─────
  const qoq = operationalQoQ(model.trends);
  if (qoq.length >= 2) {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, 'Service Desk, Quarter over Quarter');
    s.addChart(
      pptx.ChartType.bar,
      [
        { name: model.previousPeriod?.label ?? 'Previous', labels: qoq.map((t) => t.label), values: qoq.map((t) => t.previous ?? 0) },
        { name: model.period.label, labels: qoq.map((t) => t.label), values: qoq.map((t) => t.current ?? 0) },
      ],
      {
        x: CONTENT_X, y: BODY_Y + 0.1, w: CONTENT_W, h: 4.7,
        barDir: 'col',
        chartColors: [RULE, ACCENT],
        showLegend: true,
        legendPos: 'b',
        legendFontFace: FONT,
        catAxisLabelFontFace: FONT,
        catAxisLabelFontSize: 11,
        valAxisLabelFontSize: 9,
        dataLabelFontFace: FONT,
        showValue: true,
        dataLabelFontSize: 10,
        dataLabelColor: TEXT,
      },
    );
    s.addText('Support ticket volume this quarter versus last. Automated system alerts are excluded so the human-facing work is comparable.', {
      x: CONTENT_X, y: FOOTER_Y - 0.55, w: CONTENT_W, h: 0.4, fontFace: FONT, fontSize: 10, color: GRAY, italic: true, valign: 'top',
    });
    notes(
      s,
      `Talk to the trend, not the bars. ${qoq
        .map((t) => `${t.label}: ${t.previous ?? 0} to ${t.current ?? 0}`)
        .join(', ')}. Frame improvement as the value of proactive management; frame any increase honestly and say what you're doing about it.`,
    );
  }

  // ── One slide per metric section (styled, hand-paged tables) ────────────
  for (const section of model.sections) {
    addSectionSlides(pptx, section, theme);
  }

  // ── Client-authored custom sections (paragraph-paged) ───────────────────
  for (const cs of model.customSections) {
    const paras = cs.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const pages = chunkParagraphs(paras, 900);
    pages.forEach((page, idx) => {
      const s = pptx.addSlide({ masterName: 'QBR' });
      heading(s, idx === 0 ? cs.title : `${cs.title} (cont.)`);
      s.addText(page.join('\n\n'), { x: CONTENT_X, y: BODY_Y, w: CONTENT_W, h: FOOTER_Y - 0.2 - BODY_Y, fontFace: FONT, fontSize: 13, color: TEXT, valign: 'top', fit: 'shrink' });
      if (idx === 0) notes(s, cs.body);
    });
  }

  // ── Discussion & decisions ──────────────────────────────────────────────
  if (model.discussion.length) {
    addTableSlides(pptx, theme, {
      title: 'Active & Pending Conversations',
      header: ['Discussion / decision', 'Response & notes', 'Outcome'],
      rows: model.discussion.map((d: DiscussionItem) => [
        { text: d.topic, options: { fontFace: FONT, fontSize: 11, bold: true } },
        { text: d.response ?? 'To discuss', options: { fontFace: FONT, fontSize: 11 } },
        { text: discussionOutcome(d), options: { fontFace: FONT, fontSize: 11, color: ACCENT, bold: true } },
      ]),
      colW: [4.4, 5.6, 2.13],
      rowsPerSlide: 7,
      notes: `Work through each item live: capture the client's response and the agreed outcome. Topics: ${model.discussion.map((d) => d.topic).join('; ')}.`,
    });
  } else if (model.notes) {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, 'Active & Pending Conversations');
    s.addText(model.notes, { x: CONTENT_X, y: BODY_Y, w: CONTENT_W, h: 4.5, fontFace: FONT, fontSize: 12, color: TEXT, italic: true, valign: 'top', fit: 'shrink' });
    notes(s, 'Use this space to capture decisions and client responses during the meeting.');
  }

  // ── Recommendations / next 90 days ──────────────────────────────────────
  if (model.recommendations.length) {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, 'Recommendations & Next 90 Days');
    s.addText(
      model.recommendations.map((t, i) => ({ text: t, options: { bullet: { code: '2022' }, color: TEXT, paraSpaceAfter: i === model.recommendations.length - 1 ? 0 : 10 } })),
      { x: CONTENT_X, y: BODY_Y, w: CONTENT_W, h: FOOTER_Y - 0.2 - BODY_Y, fontFace: FONT, fontSize: 14, valign: 'top', fit: 'shrink' },
    );
    notes(
      s,
      'Land the meeting on next steps: for each recommendation, agree an owner and a rough timeframe, and note which ones become tickets or opportunities. These flow to the Actions tab for follow-through.',
    );
  }

  // ── Appendix: attached reports ──────────────────────────────────────────
  if (model.documents.length) {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, 'Appendix: Attached Reports');
    s.addText(
      model.documents.map((d, i) => ({
        text: `${d.name}  (${d.source})`,
        options: { bullet: { code: '2022' }, color: TEXT, paraSpaceAfter: i === model.documents.length - 1 ? 0 : 8 },
      })),
      { x: CONTENT_X, y: BODY_Y, w: CONTENT_W, h: FOOTER_Y - 0.2 - BODY_Y, fontFace: FONT, fontSize: 13, valign: 'top', fit: 'shrink' },
    );
    notes(s, 'These vendor reports travel with the PDF package; offer to walk through any of them if the client wants the detail.');
  }

  // ── Thank-you / contact ─────────────────────────────────────────────────
  {
    const s = pptx.addSlide({ masterName: 'TITLE' });
    // Deep brand field with a top accent bar; all text is light for guaranteed
    // contrast on the dark background (no dark-on-blue).
    s.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: 7.5, fill: { color: PRIMARY }, line: { type: 'none' } });
    s.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: 0.22, fill: { color: ACCENT }, line: { type: 'none' } });
    s.addShape('rect', { x: CONTENT_X, y: 2.78, w: 0.12, h: 1.9, fill: { color: ACCENT }, line: { type: 'none' } });
    s.addText('Thank you', { x: 0.95, y: 2.8, w: 11, h: 0.95, fontFace: FONT, fontSize: 44, color: 'FFFFFF', bold: true, valign: 'top' });
    s.addText(brand.tagline || `${brand.orgName}, your IT partner`, {
      x: 0.95, y: 3.85, w: 11, h: 0.5, fontFace: FONT, fontSize: 18, color: 'C7D6EE', italic: true, valign: 'top',
    });
    s.addText(`Prepared by ${brand.orgName}`, { x: 0.95, y: 4.5, w: 11, h: 0.4, fontFace: FONT, fontSize: 13, color: '8FA6C8', valign: 'top' });
  }

  const out = await pptx.write({ outputType: 'nodebuffer' });
  return out as Buffer;
}

// Telemetry-volume metrics (SIEM events, log counts) dwarf everything else on
// a shared axis and aren't executive QoQ material anyway.
const QOQ_EXCLUDE = /siem|logs|events|signals/i;
const QOQ_MAX_MAGNITUDE = 100_000;

/** First sentence of a paragraph (for a slide bullet; the rest goes to notes). */
export function firstSentence(text: string): string {
  const m = text.match(/^.*?[.!?](?=\s|$)/);
  const s = (m ? m[0] : text).trim();
  return s.length > 180 ? `${s.slice(0, 177)}…` : s;
}

// A coherent service-desk QoQ: ticket COUNTS only, in a fixed sensible order,
// excluding automated alerts and telemetry. Mixing dollars, percentages and
// alert volumes onto one axis made the slide unreadable.
const QOQ_KEYS = ['tickets.total', 'tickets.incidents', 'tickets.service', 'tickets.changes', 'sla.breaches', 'tickets.closed', 'tickets.open'];

/** Ticket-count trends for the QoQ slide, in QOQ_KEYS order, both quarters present. */
export function operationalQoQ(trends: MetricTrend[]): MetricTrend[] {
  const byKey = new Map(trends.map((t) => [t.key, t]));
  const out: MetricTrend[] = [];
  for (const key of QOQ_KEYS) {
    const t = byKey.get(key);
    if (t && t.current !== null && t.previous !== null) out.push(t);
  }
  return out;
}

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

/** Group paragraphs into pages of roughly `maxChars` so a long custom section never shrinks to unreadable. */
export function chunkParagraphs(paragraphs: string[], maxChars: number): string[][] {
  const pages: string[][] = [];
  let page: string[] = [];
  let size = 0;
  for (const p of paragraphs) {
    if (page.length && size + p.length > maxChars) {
      pages.push(page);
      page = [];
      size = 0;
    }
    page.push(p);
    size += p.length;
  }
  if (page.length || pages.length === 0) pages.push(page);
  return pages;
}

/**
 * A titled table paged by hand: one slide per chunk of rows, each with the
 * heading (continuations say so) and the header row repeated. Replaces
 * pptxgenjs autoPage, which emits continuation slides with no title.
 */
function addTableSlides(
  pptx: any,
  t: Theme,
  opts: { title: string; header: string[]; rows: unknown[][]; colW: number[]; rowsPerSlide: number; notes?: string },
): void {
  const headerRow = opts.header.map((text) => ({
    text,
    options: { bold: true, color: 'FFFFFF', fill: { color: t.PRIMARY }, fontFace: t.FONT, fontSize: 11 },
  }));
  const chunks: unknown[][][] = [];
  for (let i = 0; i < opts.rows.length; i += opts.rowsPerSlide) chunks.push(opts.rows.slice(i, i + opts.rowsPerSlide));
  if (chunks.length === 0) chunks.push([]);
  chunks.forEach((chunk, idx) => {
    const s = pptx.addSlide({ masterName: 'QBR' });
    t.heading(s, idx === 0 ? opts.title : `${opts.title} (cont.)`);
    s.addTable([headerRow, ...chunk], {
      x: CONTENT_X, y: BODY_Y, w: CONTENT_W,
      colW: opts.colW,
      border: { type: 'solid', color: RULE, pt: 0.5 },
      valign: 'top',
    });
    if (idx === 0 && opts.notes) t.notes(s, opts.notes);
  });
}

/** How many metric rows fit comfortably under one section-slide heading. */
const SECTION_ROWS_PER_SLIDE = 12;

/**
 * Section slide(s) with a styled table. Long sections are paged MANUALLY,
 * one titled slide per chunk ("… (cont.)"). The "vs last" column exists only
 * when something can be compared.
 */
function addSectionSlides(pptx: any, section: ReportSection, t: Theme): void {
  const hasPrior = section.rows.some(({ trend }) => trend && trend.previous !== null && trend.direction !== 'na');
  const headerCells = hasPrior ? ['Metric', 'This quarter', 'vs last'] : ['Metric', 'This quarter'];
  const header = headerCells.map((text) => ({
    text,
    options: { bold: true, color: 'FFFFFF', fill: { color: t.PRIMARY }, fontFace: t.FONT, fontSize: 11 },
  }));
  const bodyRow = ({ metric, trend }: ReportSection['rows'][number]) => {
    const delta = hasPrior && trend ? trendDeltaText(trend).replace(' → ', ' to ') : '';
    const deltaColor = trend?.sentiment === 'negative' ? hex(SEMANTIC.act) : trend?.sentiment === 'positive' ? hex(SEMANTIC.good) : GRAY;
    return [
      { text: metric.label, options: { fontFace: t.FONT, fontSize: 11 } },
      { text: formatValue(metric), options: { fontFace: t.FONT, fontSize: 11, align: 'right', bold: true } },
      ...(hasPrior ? [{ text: delta, options: { fontFace: t.FONT, fontSize: 11, align: 'right', color: deltaColor } }] : []),
    ];
  };

  const chunks: ReportSection['rows'][] = [];
  for (let i = 0; i < section.rows.length; i += SECTION_ROWS_PER_SLIDE) chunks.push(section.rows.slice(i, i + SECTION_ROWS_PER_SLIDE));
  if (chunks.length === 0) chunks.push([]);

  // Coaching note (first slide only): call out the most notable sentiment-bearing move.
  const notable = section.rows
    .filter((r) => r.trend && r.trend.sentiment !== 'neutral' && r.trend.sentiment !== 'na' && r.trend.previous !== null)
    .sort((a, b) => Math.abs(b.trend!.deltaPct ?? b.trend!.deltaAbs ?? 0) - Math.abs(a.trend!.deltaPct ?? a.trend!.deltaAbs ?? 0))[0];

  chunks.forEach((chunk, idx) => {
    const s = pptx.addSlide({ masterName: 'QBR' });
    t.heading(s, idx === 0 ? section.title : `${section.title} (cont.)`);
    let tableY = BODY_Y;
    if (idx === 0) {
      if (section.summary) {
        s.addText(section.summary, {
          x: CONTENT_X, y: BODY_Y, w: CONTENT_W, h: 0.6,
          fontFace: t.FONT, fontSize: 13, italic: true, color: TEXT, valign: 'top', fit: 'shrink',
        });
        tableY = BODY_Y + 0.7;
      }
      t.notes(
        s,
        [
          section.summary ?? `Walk ${section.title.toLowerCase()} at a high level: hit the headline, don't read every row.`,
          notable
            ? `Worth calling out: ${notable.metric.label} moved ${trendDeltaText(notable.trend!).replace(' → ', ' to ')} (${
                notable.trend!.sentiment === 'negative' ? 'watch this' : 'a win to highlight'
              }).`
            : '',
          'Move quickly through the numbers; spend the time on what they mean for the business.',
        ]
          .filter(Boolean)
          .join(' '),
      );
    }
    s.addTable([header, ...chunk.map(bodyRow)], {
      x: CONTENT_X, y: tableY, w: CONTENT_W,
      colW: hasPrior ? [7.6, 2.6, 1.93] : [9.2, 2.93],
      border: { type: 'solid', color: RULE, pt: 0.5 },
      valign: 'top',
    });
  });
}
