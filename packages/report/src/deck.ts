import type { DiscussionItem, MetricTrend } from '@mashit/core';
import { discussionOutcome, ratingColor, trendDeltaText, goalStatusLabel, goalStatusColor } from './format.js';
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

/**
 * Intrinsic pixel (or unit) dimensions of a data-URI image — PNG, JPEG, GIF,
 * WEBP (VP8/VP8L/VP8X) and SVG (width/height attrs or viewBox). Exported for
 * tests. Returns undefined when the format can't be read; callers then fall
 * back to the raw box.
 */
export function imageDims(dataUri: string): { w: number; h: number } | undefined {
  const m = dataUri.match(/^data:image\/([a-z+.-]+);base64,(.*)$/i);
  if (!m) return undefined;
  const kind = m[1]!.toLowerCase();
  const buf = Buffer.from(m[2]!, 'base64');
  try {
    if (kind === 'svg+xml') {
      const svg = buf.toString('utf8');
      const attr = (name: string) => {
        const a = svg.match(new RegExp(`<svg[^>]*\\b${name}="([0-9.]+)(?:px)?"`, 'i'));
        return a ? Number(a[1]) : undefined;
      };
      const w = attr('width');
      const h = attr('height');
      if (w && h) return { w, h };
      const vb = svg.match(/<svg[^>]*\bviewBox="[\d.\s-]*?([\d.]+)\s+([\d.]+)"/i);
      if (vb) return { w: Number(vb[1]), h: Number(vb[2]) };
      return undefined;
    }
    if (kind === 'png' && buf.length >= 24 && buf.readUInt32BE(12) === 0x49484452) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if ((kind === 'jpeg' || kind === 'jpg') && buf[0] === 0xff && buf[1] === 0xd8) {
      // Walk JPEG segments to a SOFn marker carrying the frame size.
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) break;
        const marker = buf[i + 1]!;
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
      return undefined;
    }
    if (kind === 'gif' && buf.length >= 10) {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    if (kind === 'webp' && buf.length >= 30 && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      if (fourcc === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) };
      }
      if (fourcc === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
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
      s.addText(brand.tagline, { x: CONTENT_X, y: 1.24, w: 4, h: 0.3, fontFace: FONT, fontSize: 10, color: ACCENT, bold: true, valign: 'top' });
    }
    // Client logo sits larger (often a small square next to a wide wordmark).
    logo(s, brand.logoDataUri, { x: PAGE_W - CONTENT_X - 2.4, y: 0.3, w: 2.4, h: 1.2, anchor: 'right' });

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
    notes(
      s,
      `Open the meeting: thank ${model.client.primaryContact ?? 'the client'} for their time and set the agenda — this quarter's results, security posture, what needs a decision, and where we go next. Keep it conversational; the slides are a backdrop for the discussion.`,
    );
  }

  // ── Executive summary ───────────────────────────────────────────────────
  if (model.executive.headline || model.executive.paragraphs.length || model.executive.highlights.length) {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, 'Executive Summary');
    let y = BODY_Y;
    if (model.executive.headline) {
      s.addText(model.executive.headline, { x: CONTENT_X, y, w: CONTENT_W, h: 0.85, fontFace: FONT, fontSize: 18, color: ACCENT, bold: true, valign: 'top', fit: 'shrink' });
      y += 1.0;
    }
    // The slide shows a few crisp talking points (highlights, or a first
    // sentence per paragraph) — never the full prose, which overflowed the
    // page. The complete narrative goes into the speaker notes below.
    const points = (model.executive.highlights.length ? model.executive.highlights : model.executive.paragraphs.map(firstSentence)).slice(0, 5);
    if (points.length) {
      s.addText(
        points.map((t, i) => ({ text: t, options: { bullet: { code: '2022' }, color: '222222', paraSpaceAfter: i === points.length - 1 ? 0 : 12 } })),
        { x: CONTENT_X, y, w: CONTENT_W, h: FOOTER_Y - 0.2 - y, fontFace: FONT, fontSize: 16, valign: 'top', fit: 'shrink' },
      );
    }
    notes(
      s,
      [
        model.executive.headline,
        '',
        ...model.executive.paragraphs,
        ...(model.executive.highlights.length ? ['', 'Highlights:', ...model.executive.highlights.map((h) => `• ${h}`)] : []),
      ]
        .filter((l) => l !== undefined)
        .join('\n'),
    );
  }

  // ── Strategic goals & IT alignment ──────────────────────────────────────
  if (model.goals.length) {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, 'Strategic Goals & IT Alignment');
    const rows = [
      ['Goal', 'How we support it', 'Status'].map((t) => ({
        text: t,
        options: { bold: true, color: 'FFFFFF', fill: { color: PRIMARY }, fontFace: FONT, fontSize: 11 },
      })),
      ...model.goals.map((g) => [
        {
          text: g.targetPeriod ? `${g.title}\n(target ${g.targetPeriod})` : g.title,
          options: { fontFace: FONT, fontSize: 11, bold: true },
        },
        { text: g.alignment ?? '—', options: { fontFace: FONT, fontSize: 11 } },
        { text: goalStatusLabel(g.status), options: { fontFace: FONT, fontSize: 11, bold: true, color: 'FFFFFF', fill: { color: hex(goalStatusColor(g.status)) } } },
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
    notes(
      s,
      `Tie the quarter's work back to what the client is trying to achieve. Walk each goal, confirm the status is still right, and ask what's changed on their side. Goals: ${model.goals
        .map((g) => `${g.title} (${goalStatusLabel(g.status)})`)
        .join('; ')}.`,
    );
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

    // Unmeasured functions must not chart as 0 — with sparse data a radar
    // collapses into misleading spikes, so switch to horizontal bars.
    const fns = sc.functions.filter((f) => f.score !== null);
    if (fns.length >= 3) {
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
    } else if (fns.length > 0) {
      s.addChart(
        pptx.ChartType.bar,
        [{ name: 'Maturity', labels: fns.map((f) => f.function), values: fns.map((f) => f.score ?? 0) }],
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
      const missing = sc.functions.filter((f) => f.score === null).map((f) => f.function);
      if (missing.length) {
        s.addText(`Not yet measured: ${missing.join(', ')}`, {
          x: 5.4, y: BODY_Y + 1.5 + fns.length * 0.8, w: 7.2, h: 0.4, fontFace: FONT, fontSize: 10, color: GRAY, valign: 'top',
        });
      }
    }
    const weakest = sc.functions.filter((f) => f.score !== null).sort((a, b) => (a.score ?? 0) - (b.score ?? 0)).slice(0, 2);
    notes(
      s,
      `Explain the score in plain terms: it blends the security safeguards we can measure (MFA, endpoint protection, patching, backups) against an industry checklist, grouped under the NIST framework. It's a posture guide, not a compliance audit. Overall ${
        sc.overall.score === null ? 'not yet scored' : `${Math.round(sc.overall.score)}/100 (${sc.overall.rating})`
      }.${weakest.length ? ` Point the conversation at where to invest next: ${weakest.map((f) => f.function).join(' and ')}.` : ''}`,
    );
  }

  // ── Service desk, quarter over quarter (coherent ticket counts only) ─────
  const qoq = operationalQoQ(model.trends);
  if (qoq.length >= 2) {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, 'Service Desk — Quarter over Quarter');
    s.addChart(
      pptx.ChartType.bar,
      [
        { name: model.previousPeriod?.label ?? 'Previous', labels: qoq.map((t) => t.label), values: qoq.map((t) => t.previous ?? 0) },
        { name: model.period.label, labels: qoq.map((t) => t.label), values: qoq.map((t) => t.current ?? 0) },
      ],
      {
        x: CONTENT_X, y: BODY_Y + 0.1, w: CONTENT_W, h: 4.7,
        barDir: 'col',
        chartColors: ['B9C4CF', ACCENT],
        showLegend: true,
        legendPos: 'b',
        legendFontFace: FONT,
        catAxisLabelFontFace: FONT,
        catAxisLabelFontSize: 11,
        valAxisLabelFontSize: 9,
        dataLabelFontFace: FONT,
        showValue: true,
        dataLabelFontSize: 10,
        dataLabelColor: '333333',
      },
    );
    s.addText('Support ticket volume this quarter versus last — automated system alerts are excluded so the human-facing work is comparable.', {
      x: CONTENT_X, y: FOOTER_Y - 0.55, w: CONTENT_W, h: 0.4, fontFace: FONT, fontSize: 10, color: GRAY, italic: true, valign: 'top',
    });
    notes(
      s,
      `Talk to the trend, not the bars. ${qoq
        .map((t) => `${t.label}: ${t.previous ?? 0} → ${t.current ?? 0}`)
        .join(', ')}. Frame improvement as the value of proactive management; frame any increase honestly and say what you're doing about it.`,
    );
  }

  // ── One slide per metric section (styled, auto-paging tables) ───────────
  for (const section of model.sections) {
    addSectionSlides(pptx, section, { PRIMARY, ACCENT, FONT, heading, notes });
  }

  // ── Client-authored custom sections ─────────────────────────────────────
  for (const cs of model.customSections) {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, cs.title);
    s.addText(cs.body, { x: CONTENT_X, y: BODY_Y, w: CONTENT_W, h: FOOTER_Y - 0.2 - BODY_Y, fontFace: FONT, fontSize: 13, color: '222222', valign: 'top', fit: 'shrink' });
    notes(s, cs.body);
  }

  // ── Discussion & decisions ──────────────────────────────────────────────
  if (model.discussion.length || model.notes) {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, 'Active & Pending Conversations');
    if (model.discussion.length) {
      const rows = [
        ['Discussion / decision', 'Response & notes', 'Outcome'].map((t) => ({
          text: t,
          options: { bold: true, color: 'FFFFFF', fill: { color: PRIMARY }, fontFace: FONT, fontSize: 11 },
        })),
        ...model.discussion.map((d: DiscussionItem) => [
          { text: d.topic, options: { fontFace: FONT, fontSize: 11, bold: true } },
          { text: d.response ?? '—', options: { fontFace: FONT, fontSize: 11 } },
          { text: discussionOutcome(d), options: { fontFace: FONT, fontSize: 11, color: ACCENT, bold: true } },
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
    notes(
      s,
      model.discussion.length
        ? `Work through each item live — capture the client's response and the agreed outcome. Topics: ${model.discussion.map((d) => d.topic).join('; ')}.`
        : 'Use this space to capture decisions and client responses during the meeting.',
    );
  }

  // ── Recommendations / next 90 days ──────────────────────────────────────
  if (model.recommendations.length) {
    const s = pptx.addSlide({ masterName: 'QBR' });
    heading(s, 'Recommendations & Next 90 Days');
    s.addText(
      model.recommendations.map((t, i) => ({ text: t, options: { bullet: { code: '2022' }, color: '222222', paraSpaceAfter: i === model.recommendations.length - 1 ? 0 : 10 } })),
      { x: CONTENT_X, y: BODY_Y, w: CONTENT_W, h: FOOTER_Y - 0.2 - BODY_Y, fontFace: FONT, fontSize: 14, valign: 'top', fit: 'shrink' },
    );
    notes(
      s,
      'Land the meeting on next steps: for each recommendation, agree an owner and a rough timeframe, and note which ones become tickets or opportunities. These flow to the Actions tab for follow-through.',
    );
  }

  // ── Thank-you / contact ─────────────────────────────────────────────────
  {
    const s = pptx.addSlide({ masterName: 'TITLE' });
    // Deep brand field with a top accent bar; all text is LIGHT for guaranteed
    // contrast on the dark background (no dark-on-blue).
    s.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: 7.5, fill: { color: PRIMARY }, line: { type: 'none' } });
    s.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: 0.22, fill: { color: ACCENT }, line: { type: 'none' } });
    s.addShape('rect', { x: CONTENT_X, y: 2.78, w: 0.12, h: 1.9, fill: { color: ACCENT }, line: { type: 'none' } });
    s.addText('Thank you', { x: 0.95, y: 2.8, w: 11, h: 0.95, fontFace: FONT, fontSize: 44, color: 'FFFFFF', bold: true, valign: 'top' });
    s.addText(brand.tagline || `${brand.orgName} — your IT partner`, {
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
// alert volumes onto one axis (the old pickMovers behavior for this chart) made
// the slide unreadable.
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

/** Section slide with a styled table (auto-pages over extra slides when long). */
function addSectionSlides(
  pptx: any,
  section: ReportSection,
  t: {
    PRIMARY: string;
    ACCENT: string;
    FONT: string;
    heading: (slide: any, text: string) => void;
    notes: (slide: any, text: string) => void;
  },
): void {
  const s = pptx.addSlide({ masterName: 'QBR' });
  t.heading(s, section.title);
  // Coach the presenter to talk to the story, not read the table. Call out the
  // most notable move (biggest sentiment-bearing change) as the thing to raise.
  const notable = section.rows
    .filter((r) => r.trend && r.trend.sentiment !== 'neutral' && r.trend.sentiment !== 'na' && r.trend.deltaPct !== null)
    .sort((a, b) => Math.abs(b.trend!.deltaPct ?? 0) - Math.abs(a.trend!.deltaPct ?? 0))[0];
  t.notes(
    s,
    [
      section.summary ?? `Walk ${section.title.toLowerCase()} at a high level — hit the headline, don't read every row.`,
      notable
        ? `Worth calling out: ${notable.metric.label} moved ${trendDeltaText(notable.trend!)} (${
            notable.trend!.sentiment === 'negative' ? 'watch this' : 'a win to highlight'
          }).`
        : '',
      'Move quickly through the numbers; spend the time on what they mean for the business.',
    ]
      .filter(Boolean)
      .join(' '),
  );
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
      const delta = trend ? trendDeltaText(trend) : '';
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
