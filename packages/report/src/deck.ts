import { formatValue } from './format.js';
import type { ReportModel } from './model.js';

/**
 * Generate the meeting PowerPoint deck from the same report model. pptxgenjs is
 * an optional peer dependency, imported dynamically so the package builds and
 * unit-tests without it.
 */
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
  pptx.defineLayout({ name: 'WIDE', width: 13.333, height: 7.5 });
  pptx.layout = 'WIDE';

  const PRIMARY = '0B2545';
  const ACCENT = '1D7874';

  // Title slide
  const title = pptx.addSlide();
  title.addText('Quarterly Business Review', { x: 0.6, y: 2.4, fontSize: 20, color: ACCENT, bold: true });
  title.addText(model.client.name, { x: 0.6, y: 3.0, fontSize: 40, color: PRIMARY, bold: true });
  title.addText(model.period.label + (model.heldBy ? `  ·  ${model.heldBy}` : ''), { x: 0.6, y: 4.0, fontSize: 18, color: '555555' });

  // Executive summary
  if (model.executive.headline || model.executive.paragraphs.length) {
    const s = pptx.addSlide();
    s.addText('Executive Summary', { x: 0.6, y: 0.4, fontSize: 24, color: PRIMARY, bold: true });
    if (model.executive.headline) s.addText(model.executive.headline, { x: 0.6, y: 1.1, fontSize: 16, color: ACCENT, bold: true });
    const bullets = [...model.executive.paragraphs, ...model.executive.highlights].map((t) => ({ text: t, options: { bullet: true } }));
    if (bullets.length) s.addText(bullets as any, { x: 0.6, y: 1.8, w: 12, fontSize: 13, color: '222222' });
  }

  // Security scorecard
  const sc = pptx.addSlide();
  sc.addText('Security & Risk Maturity', { x: 0.6, y: 0.4, fontSize: 24, color: PRIMARY, bold: true });
  const overall = model.scorecard.overall.score === null ? '—' : Math.round(model.scorecard.overall.score).toString();
  sc.addText(`${overall} / 100 — ${model.scorecard.overall.rating.toUpperCase()}`, { x: 0.6, y: 1.1, fontSize: 18, color: ACCENT, bold: true });
  const fnRows = [
    ['Function', 'Score', 'Rating'],
    ...model.scorecard.functions.map((f) => [f.function, f.score === null ? '—' : String(Math.round(f.score)), f.rating]),
  ];
  sc.addTable(fnRows as any, { x: 0.6, y: 1.9, w: 6, fontSize: 12, border: { type: 'solid', color: 'DDDDDD' } });

  // One slide per metric section
  for (const section of model.sections) {
    const s = pptx.addSlide();
    s.addText(section.title, { x: 0.6, y: 0.4, fontSize: 22, color: PRIMARY, bold: true });
    const rows = [
      ['Metric', 'This quarter', 'vs last'],
      ...section.rows.map(({ metric, trend }) => [
        metric.label,
        formatValue(metric),
        trend && trend.previous !== null && trend.deltaPct !== null ? `${trend.deltaPct > 0 ? '+' : ''}${trend.deltaPct}%` : '',
      ]),
    ];
    s.addTable(rows as any, { x: 0.6, y: 1.2, w: 12, fontSize: 12, border: { type: 'solid', color: 'DDDDDD' } });
  }

  // Recommendations
  if (model.recommendations.length) {
    const s = pptx.addSlide();
    s.addText('Recommendations & Next 90 Days', { x: 0.6, y: 0.4, fontSize: 22, color: PRIMARY, bold: true });
    s.addText(
      model.recommendations.map((t) => ({ text: t, options: { bullet: true } })) as any,
      { x: 0.6, y: 1.2, w: 12, fontSize: 14, color: '222222' },
    );
  }

  const out = await pptx.write({ outputType: 'nodebuffer' });
  return out as Buffer;
}
