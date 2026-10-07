import type { DiscussionItem, MetricTrend } from '@mashit/core';
import { ratingColor, ratingWord, trendDeltaText, goalStatusLabel, goalStatusColor, SEMANTIC } from './format.js';
import { formatValue } from './format.js';
import { moversCaption, selectKpiTiles, selectMovers } from './charts.js';
import { imageDims } from './images.js';
import { conversationStatus, type ReportModel, type ReportSection } from './model.js';
import {
  basisText,
  BUDGET_CATEGORY_LABEL,
  conversationColor,
  CONVERSATION_LABEL,
  decisionSubline,
  DECISIONS_LEDE,
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
  sinceLabel,
  whatToFixFirst,
} from './pages.js';

export { imageDims } from './images.js';

/**
 * The meeting PowerPoint deck, one slide per report page in the same order
 * and with the same titles (cover, page one, protection, decisions and the
 * next 90 days, investment, the planning outlook in the planning quarter,
 * quarter in numbers as appendix slides, appendix), built for presentation:
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
          // Same sentence as the PDF and HTML footer: confidentiality (HIPAA) and any revision date.
          text: footerText(model),
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
    s.addText(`Prepared by ${brand.orgName}. ${model.client.hipaa ? 'Contains confidential client information (HIPAA).' : 'Confidential.'}`, {
      x: CONTENT_X, y: 6.9, w: 8, h: 0.35, fontFace: FONT, fontSize: 10, color: GRAY, valign: 'top',
    });
    notes(
      s,
      `Open the meeting: thank ${model.client.primaryContact ?? 'the client'} for their time and set the agenda: this quarter's results, security posture, what needs a decision, and where we go next. Keep it conversational; the slides are a backdrop for the discussion.`,
    );
  }

  // Client-authored custom sections (paragraph-paged), placed where the author put them.
  const addCustomSlides = (cs: { title: string; body: string }) => {
    const paras = cs.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const pages = chunkParagraphs(paras, 900);
    pages.forEach((page, idx) => {
      const s = pptx.addSlide({ masterName: 'QBR' });
      heading(s, idx === 0 ? cs.title : `${cs.title} (cont.)`);
      s.addText(page.join('\n\n'), { x: CONTENT_X, y: BODY_Y, w: CONTENT_W, h: FOOTER_Y - 0.2 - BODY_Y, fontFace: FONT, fontSize: 13, color: TEXT, valign: 'top', fit: 'shrink' });
      if (idx === 0) notes(s, cs.body);
    });
  };

  // The score visual (doughnut + radar) rides with the numbers as an appendix slide.
  const addMaturitySlide = () => {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, 'Security maturity score');
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
    };

  // ── Page one: headline, lede, tiles, did / saw / need, since last quarter ─
  // Nothing shrinks to fit: text boxes are sized from an estimate of the
  // wrapped lines, and when the three columns do not fit under the lede and
  // tiles they move, with Since last quarter, to a continuation slide.
  {
    const lines = (text: string, charsPerLine: number) => Math.max(1, Math.ceil(text.length / charsPerLine));
    let s = pptx.addSlide({ masterName: 'QBR' });
    const title = model.executive.headline || PAGE_TITLES.fallbackHeadline;
    heading(s, title);
    let y = BODY_Y;
    if (model.executive.lede) {
      const h = lines(model.executive.lede, 125) * 0.27 + 0.1;
      s.addText(model.executive.lede, { x: CONTENT_X, y, w: CONTENT_W, h, fontFace: FONT, fontSize: 14, color: TEXT, valign: 'top' });
      y += h + 0.1;
    }
    const tiles = selectKpiTiles(model);
    if (tiles.length >= 2) {
      const gap = 0.15;
      const tw = (CONTENT_W - gap * (tiles.length - 1)) / tiles.length;
      tiles.forEach((t, i) => {
        const x = CONTENT_X + i * (tw + gap);
        s.addShape('rect', { x, y, w: tw, h: 0.9, fill: { color: hex(SEMANTIC.canvas) }, line: { type: 'none' } });
        s.addText(
          [
            { text: t.value, options: { bold: true, fontSize: 20, color: hex(t.color), breakLine: true } },
            { text: t.label, options: { fontSize: 10, color: TEXT, breakLine: !!t.note } },
            ...(t.note ? [{ text: t.note, options: { fontSize: 10, color: GRAY } }] : []),
          ],
          { x: x + 0.12, y, w: tw - 0.24, h: 0.9, fontFace: FONT, valign: 'middle' },
        );
      });
      y += 1.05;
    }
    const colW = (CONTENT_W - 0.4) / 3;
    const perLine = 0.22;
    const listHeight = (items: string[]) => items.reduce((h, t) => h + lines(t, 40) * perLine + 0.08, 0);
    const needHeight = model.decisions.reduce((h, d) => h + lines(d.ask, 40) * perLine + (decisionSubline(d) ? lines(decisionSubline(d), 48) * 0.18 : 0) + 0.08, 0);
    const bodyH = Math.max(listHeight(model.executive.did), listHeight(model.executive.saw), needHeight, perLine) + 0.1;
    const colH = 0.5 + bodyH;
    const sinceH = model.sinceLastQuarter.length ? 0.36 + 0.24 * model.sinceLastQuarter.length : 0;
    if (y + colH + (sinceH ? sinceH + 0.15 : 0) > FOOTER_Y - 0.15) {
      notes(s, model.executive.lede ?? '');
      s = pptx.addSlide({ masterName: 'QBR' });
      heading(s, `${title} (cont.)`);
      y = BODY_Y;
    }
    const bullets = (items: string[]) =>
      items.length
        ? items.map((t, i) => ({ text: t, options: { bullet: { code: '2022' }, color: TEXT, paraSpaceAfter: i === items.length - 1 ? 0 : 6 } }))
        : [{ text: 'Nothing to report this quarter.', options: { color: GRAY } }];
    const column = (i: number, heading: string, body: Array<{ text: string; options: Record<string, unknown> }>, need = false) => {
      const x = CONTENT_X + i * (colW + 0.2);
      if (need) s.addShape('rect', { x, y, w: colW, h: colH, fill: { color: hex(SEMANTIC.watchBg) }, line: { type: 'none' } });
      s.addShape('rect', { x, y, w: colW, h: 0.04, fill: { color: need ? hex(SEMANTIC.watch) : RULE }, line: { type: 'none' } });
      s.addText(heading, { x: x + (need ? 0.1 : 0), y: y + 0.08, w: colW - 0.2, h: 0.32, fontFace: FONT, fontSize: 13, bold: true, color: need ? hex(SEMANTIC.watch) : PRIMARY, valign: 'top' });
      s.addText(body, { x: x + (need ? 0.1 : 0), y: y + 0.45, w: colW - 0.2, h: bodyH, fontFace: FONT, fontSize: 12, valign: 'top' });
    };
    column(0, 'What we did', bullets(model.executive.did));
    column(1, 'What we saw', bullets(model.executive.saw));
    column(
      2,
      'What we need from you',
      model.decisions.length
        ? model.decisions.flatMap((d, i) => {
            const sub = decisionSubline(d);
            return [
              { text: `□  ${d.ask}`, options: { color: TEXT, breakLine: true } },
              ...(sub ? [{ text: sub, options: { color: GRAY, fontSize: 10, breakLine: i < model.decisions.length - 1 } }] : []),
            ];
          })
        : [{ text: 'Nothing needs your decision this quarter.', options: { color: TEXT } }],
      true,
    );
    y += colH + 0.15;
    if (model.sinceLastQuarter.length) {
      s.addShape('rect', { x: CONTENT_X, y, w: CONTENT_W, h: sinceH, fill: { color: hex(SEMANTIC.canvas) }, line: { type: 'none' } });
      s.addShape('rect', { x: CONTENT_X, y, w: 0.06, h: sinceH, fill: { color: PRIMARY }, line: { type: 'none' } });
      s.addText(
        [
          { text: 'Since last quarter', options: { bold: true, color: hex(SEMANTIC.ink), breakLine: true } },
          ...model.sinceLastQuarter.map((r, i) => ({
            text: `${r.topic}: ${sinceLabel(r)}`,
            options: { color: TEXT, breakLine: i < model.sinceLastQuarter.length - 1 },
          })),
        ],
        { x: CONTENT_X + 0.2, y, w: CONTENT_W - 0.3, h: sinceH, fontFace: FONT, fontSize: 11, valign: 'middle' },
      );
    }
    notes(
      s,
      [
        model.executive.headline ?? '',
        '',
        model.executive.lede ?? '',
        ...(model.dataConfidence.length ? ['', 'Data confidence (say this out loud before the numbers):', ...model.dataConfidence.map((w) => `- ${w}`)] : []),
      ].join('\n'),
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
      title: PAGE_TITLES.goals,
      header,
      rows,
      colW: [4.4, 5.6, 2.13],
      rowsPerSlide: 6,
      notes: `Tie the quarter's work back to what the client is trying to achieve. Walk each goal, confirm the status is still right, and ask what's changed on their side. Goals: ${model.goals
        .map((g) => `${g.title} (${goalStatusLabel(g.status)})`)
        .join('; ')}.`,
    });
  }
  for (const cs of model.customSections.filter((c) => c.placement === 'after-summary')) addCustomSlides(cs);

  // ── How we are protecting you: the five questions ───────────────────────
  addTableSlides(pptx, theme, {
    title: PAGE_TITLES.protection,
    header: ['The question', 'What is in place', 'This quarter', 'Status'],
    rows: model.protection.map((row) => [
      { text: `${row.question}\n${PROTECTION_SUBTITLE[row.id] ?? ''}`, options: { fontFace: FONT, fontSize: 11, bold: true, color: hex(SEMANTIC.ink) } },
      { text: protectionInPlace(row), options: { fontFace: FONT, fontSize: 11 } },
      { text: protectionThisQuarter(row), options: { fontFace: FONT, fontSize: 11 } },
      {
        text: `${protectionStatusWord(row)}\n${functionScoresText(row)}`,
        options: { fontFace: FONT, fontSize: 11, bold: true, color: 'FFFFFF', fill: { color: hex(ratingColor(row.rating)) } },
      },
    ]),
    colW: [2.5, 4.0, 3.6, 2.03],
    rowsPerSlide: 5,
    notes: [ringNote(model), whatToFixFirst(model) ? `What to fix first: ${whatToFixFirst(model)}` : ''].filter(Boolean).join('\n\n'),
  });

  // ── Decisions and the next 90 days ──────────────────────────────────────
  if (showDecisionsPage(model)) {
    if (model.discussion.length) {
      addTableSlides(pptx, theme, {
        title: PAGE_TITLES.decisions,
        header: ['Topic', 'Where it stands', 'Owner', 'Status'],
        rows: model.discussion.map((d: DiscussionItem) => {
          const status = conversationStatus(d);
          return [
            { text: d.topic, options: { fontFace: FONT, fontSize: 11, bold: true } },
            { text: d.response?.trim() || 'To discuss', options: { fontFace: FONT, fontSize: 11 } },
            { text: d.owner ?? '', options: { fontFace: FONT, fontSize: 11 } },
            { text: CONVERSATION_LABEL[status], options: { fontFace: FONT, fontSize: 11, bold: true, color: 'FFFFFF', fill: { color: hex(conversationColor(status, brand.primary)) } } },
          ];
        }),
        colW: [3.4, 5.4, 1.6, 1.73],
        rowsPerSlide: 6,
        notes: `${DECISIONS_LEDE} Work through each item live: capture the client's response and the agreed outcome.${model.notes ? `\n\nMeeting notes: ${model.notes}` : ''}`,
      });
    } else if (model.notes && !hasPlan(model)) {
      const s = pptx.addSlide({ masterName: 'QBR' });
      heading(s, PAGE_TITLES.decisions);
      s.addText(model.notes, { x: CONTENT_X, y: BODY_Y, w: CONTENT_W, h: 4.5, fontFace: FONT, fontSize: 12, color: TEXT, italic: true, valign: 'top', fit: 'shrink' });
      notes(s, 'Use this space to capture decisions and client responses during the meeting.');
    }
    if (hasPlan(model)) {
      const depth = Math.max(...PLAN_COLUMNS.map((c) => model.plan[c.key].length));
      const cell = (key: (typeof PLAN_COLUMNS)[number]['key'], i: number) => {
        const p = model.plan[key][i];
        return {
          text: p ? `${p.action}\n${p.owner}${p.decision ? `\n${planDecisionLabel(model, p)}` : ''}` : '',
          options: { fontFace: FONT, fontSize: 11, color: TEXT },
        };
      };
      addTableSlides(pptx, theme, {
        title: model.discussion.length || model.notes ? 'The next 90 days' : PAGE_TITLES.decisions,
        header: PLAN_COLUMNS.map((c) => `${c.title} (${c.span})`),
        rows: Array.from({ length: depth }, (_, i) => PLAN_COLUMNS.map((c) => cell(c.key, i))),
        colW: [CONTENT_W / 3, CONTENT_W / 3, CONTENT_W / 3],
        rowsPerSlide: 3,
        notes: 'Land the meeting on next steps: agree an owner and a rough timeframe for each item, and get a yes or no on every item marked "Your decision". These flow to the Actions tab for follow-through.',
      });
    }
  }

  // ── Your IT investment ──────────────────────────────────────────────────
  const inv = model.investment;
  if (showInvestmentPage(inv)) {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, PAGE_TITLES.investment);
    let y = BODY_Y;
    const lede = investmentLede(inv);
    if (lede) {
      s.addText(lede, { x: CONTENT_X, y, w: CONTENT_W, h: 0.55, fontFace: FONT, fontSize: 14, color: TEXT, valign: 'top', fit: 'shrink' });
      y += 0.62;
    }
    if (inv.invoiced > 0) {
      const tw = (CONTENT_W - 0.3) / 3;
      investmentTiles(inv).forEach((t, i) => {
        const x = CONTENT_X + i * (tw + 0.15);
        s.addShape('rect', { x, y, w: tw, h: 0.9, fill: { color: hex(SEMANTIC.canvas) }, line: { type: 'none' } });
        s.addText(
          [
            { text: t.value, options: { bold: true, fontSize: 22, color: PRIMARY, breakLine: true } },
            { text: t.label, options: { fontSize: 11, color: TEXT, breakLine: !!t.note } },
            ...(t.note ? [{ text: t.note, options: { fontSize: 10, color: GRAY } }] : []),
          ],
          { x: x + 0.12, y, w: tw - 0.24, h: 0.9, fontFace: FONT, valign: 'middle', fit: 'shrink' },
        );
      });
      y += 1.05;
    }
    const bars = inv.breakdown.slice(0, 7);
    const rightX = CONTENT_X + CONTENT_W * 0.58;
    if (bars.length) {
      s.addText('Where it went', { x: CONTENT_X, y, w: 6, h: 0.35, fontFace: FONT, fontSize: 14, bold: true, color: PRIMARY, valign: 'top' });
      s.addChart(
        pptx.ChartType.bar,
        [{ name: 'Invoiced', labels: bars.map((b) => b.label), values: bars.map((b) => b.amount) }],
        {
          x: CONTENT_X, y: y + 0.35, w: CONTENT_W * 0.56, h: FOOTER_Y - 0.2 - y - 0.35,
          barDir: 'bar',
          chartColors: [PRIMARY],
          showLegend: false,
          catAxisOrientation: 'maxMin',
          catAxisLabelFontFace: FONT,
          catAxisLabelFontSize: 10,
          valAxisHidden: true,
          valGridLine: { style: 'none' },
          showValue: true,
          dataLabelFormatCode: '$#,##0',
          dataLabelFontSize: 10,
          dataLabelColor: TEXT,
        },
      );
    }
    const side: Array<{ text: string; options: Record<string, unknown> }> = [];
    if (inv.planVsActual) {
      side.push({ text: `${inv.planVsActual.fiscalYearLabel} plan versus actual`, options: { bold: true, color: hex(SEMANTIC.ink), breakLine: true } });
      side.push({ text: planVsActualText(inv.planVsActual), options: { color: TEXT, breakLine: true, paraSpaceAfter: 10 } });
    }
    if (inv.comingUp.length) {
      side.push({ text: 'Coming up', options: { bold: true, color: hex(SEMANTIC.ink), breakLine: true } });
      inv.comingUp.forEach((c, i) => side.push({ text: c, options: { bullet: { code: '2022' }, color: TEXT, breakLine: i < inv.comingUp.length - 1 } }));
    }
    if (side.length) {
      s.addText(side, { x: bars.length ? rightX : CONTENT_X, y, w: bars.length ? CONTENT_X + CONTENT_W - rightX : CONTENT_W, h: FOOTER_Y - 0.2 - y, fontFace: FONT, fontSize: 12, valign: 'top', fit: 'shrink' });
    }
    notes(s, 'Walk the money plainly: what was invoiced, how much is the steady recurring agreement, and what was project or hourly work. Then preview what is coming so nothing in next year\'s budget is a surprise.');
  }

  // ── Planning your FY IT budget (planning quarter only) ──────────────────
  if (inv?.outlook) {
    const o = inv.outlook;
    const cell = (text: string, opts: Record<string, unknown> = {}) => ({ text, options: { fontFace: FONT, fontSize: 11, ...opts } });
    addTableSlides(pptx, theme, {
      title: planningTitle(o),
      header: ['Category', 'Low', 'Expected', 'High', 'Based on'],
      rows: [
        ...o.lines.map((l) => [
          cell(BUDGET_CATEGORY_LABEL[l.category] ?? l.category, { bold: true }),
          cell(money(l.low), { align: 'right' }),
          cell(money(l.expected), { align: 'right' }),
          cell(money(l.high), { align: 'right' }),
          cell(basisText(l)),
        ]),
        [cell('Total', { bold: true }), cell(money(o.totals.low), { align: 'right', bold: true }), cell(money(o.totals.expected), { align: 'right', bold: true }), cell(money(o.totals.high), { align: 'right', bold: true }), cell('')],
      ],
      colW: [2.4, 1.4, 1.4, 1.4, 5.53],
      rowsPerSlide: 8,
      notes: `${PLANNING_LEDE}${o.caveats.length ? `\n\nCaveats: ${o.caveats.join(' ')}` : ''}`,
    });
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, `${planningTitle(o)} (cont.)`);
    s.addText(
      [
        ...(o.assumptions.length ? [{ text: 'What we assumed with you. ', options: { bold: true, color: hex(SEMANTIC.ink) } }, { text: o.assumptions.join(' '), options: { color: TEXT, breakLine: true, paraSpaceAfter: 12 } }] : []),
        ...(o.movers.length ? [{ text: 'What would move it. ', options: { bold: true, color: hex(SEMANTIC.ink) } }, { text: o.movers.join(' '), options: { color: TEXT, breakLine: true, paraSpaceAfter: 12 } }] : []),
        { text: 'Decisions for the plan', options: { bold: true, color: PRIMARY, breakLine: true } },
        ...planningDecisions(o).map((d) => ({ text: d, options: { bullet: { code: '2022' }, color: TEXT } })),
      ],
      { x: CONTENT_X, y: BODY_Y, w: CONTENT_W, h: FOOTER_Y - 0.2 - BODY_Y, fontFace: FONT, fontSize: 14, valign: 'top', fit: 'shrink' },
    );
  }

  // ── Quarter in numbers (appendix slides), opening with the movers ───────
  const qoq = operationalQoQ(model.trends);
  const movers = selectMovers(model.trends);
  if (model.sections.length || qoq.length >= 2 || movers.length >= 2) {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, PAGE_TITLES.numbers);
    if (movers.length >= 2) {
      s.addText('What changed this quarter', { x: CONTENT_X, y: BODY_Y, w: CONTENT_W, h: 0.35, fontFace: FONT, fontSize: 15, bold: true, color: PRIMARY, valign: 'top' });
      s.addText(moversCaption(model.trends), { x: CONTENT_X, y: BODY_Y + 0.38, w: CONTENT_W, h: 0.45, fontFace: FONT, fontSize: 10, color: GRAY, valign: 'top' });
      const labels = movers.map((m) => `${m.label} (${m.deltaText})`);
      s.addChart(
        pptx.ChartType.bar,
        [
          { name: 'Improved', labels, values: movers.map((m) => (m.good ? m.magnitude : 0)) },
          { name: 'Needs attention', labels, values: movers.map((m) => (m.good ? 0 : -m.magnitude)) },
        ],
        {
          x: CONTENT_X, y: BODY_Y + 0.9, w: CONTENT_W, h: FOOTER_Y - 0.3 - (BODY_Y + 0.9),
          barDir: 'bar',
          barGrouping: 'stacked',
          chartColors: [hex(SEMANTIC.good), hex(SEMANTIC.act)],
          catAxisOrientation: 'maxMin',
          catAxisLabelFontFace: FONT,
          catAxisLabelFontSize: 11,
          catAxisLabelPos: 'low',
          valAxisHidden: true,
          valGridLine: { style: 'none' },
          showLegend: true,
          legendPos: 'b',
          legendFontFace: FONT,
          legendFontSize: 10,
        },
      );
      notes(s, `Lead with what moved most: ${movers.map((m) => `${m.label} ${m.deltaText}`).join(', ')}. The detailed tables follow as appendix slides.`);
    } else {
      const summaries = model.sections.map((sec) => `${sec.title}${sec.summary ? `: ${sec.summary}` : ''}`);
      s.addText(
        summaries.map((t, i) => ({ text: t, options: { bullet: { code: '2022' }, color: TEXT, paraSpaceAfter: i === summaries.length - 1 ? 0 : 10 } })),
        { x: CONTENT_X, y: BODY_Y, w: CONTENT_W, h: FOOTER_Y - 0.2 - BODY_Y, fontFace: FONT, fontSize: 14, valign: 'top' },
      );
      notes(s, 'The detailed tables follow as appendix slides; skim them only if the client asks.');
    }
    if (qoq.length >= 2) {
      const q = pptx.addSlide({ masterName: 'QBR' });
      heading(q, 'Service desk, quarter over quarter');
      q.addChart(
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
          valAxisLabelFontSize: 10,
          dataLabelFontFace: FONT,
          showValue: true,
          dataLabelFontSize: 10,
          dataLabelColor: TEXT,
        },
      );
      q.addText('Support ticket volume this quarter versus last. Automated system alerts are excluded so the human-facing work is comparable.', {
        x: CONTENT_X, y: FOOTER_Y - 0.55, w: CONTENT_W, h: 0.4, fontFace: FONT, fontSize: 10, color: GRAY, italic: true, valign: 'top',
      });
      notes(
        q,
        `Talk to the trend, not the bars. ${qoq
          .map((t) => `${t.label}: ${t.previous ?? 0} to ${t.current ?? 0}`)
          .join(', ')}. Frame improvement as the value of proactive management; frame any increase honestly and say what you're doing about it.`,
      );
    }
    addMaturitySlide();
    for (const section of model.sections) addSectionSlides(pptx, section, theme);
  }
  for (const cs of model.customSections.filter((c) => (c.placement ?? 'in-body') === 'in-body')) addCustomSlides(cs);
  for (const cs of model.customSections.filter((c) => c.placement === 'end')) addCustomSlides(cs);

  // ── Appendix: attached reports and how we score ─────────────────────────
  {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, model.documents.length ? PAGE_TITLES.appendixWithReports : PAGE_TITLES.appendixScoring);
    const docs = model.documents.map((d) => ({ text: `${d.name}  (${d.source})`, options: { bullet: { code: '2022' }, color: TEXT, breakLine: true } }));
    s.addText(
      [
        ...docs,
        ...(docs.length ? [{ text: 'How we score', options: { bold: true, color: PRIMARY, breakLine: true, paraSpaceBefore: 12 } }] : []),
        { text: howWeScore(model), options: { color: TEXT } },
      ],
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
