/**
 * CLI: generate a QBR for a client/period and write HTML + the designed PDF
 * to an output folder. The fastest way to run the tool — Node only, no Azure
 * tooling.
 *
 *   node apps/api/dist/cli.js <clientId> <period> [outDir] [--ai]
 *   e.g. node apps/api/dist/cli.js anp 2026-Q1 out
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClaudeNarrativeModel } from '@mashit/narrative';
import { renderPdf } from '@mashit/report';
import { buildQbrReport, renderQbrHtml } from './service.js';
import { getDataStore, loadReportInputs, narrativeCacheFor, storeDataSource } from './store/index.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const pos = args.filter((a) => !a.startsWith('--'));

  const clientId = pos[0] ?? 'anp';
  const period = pos[1] ?? '2026-Q1';
  const outDir = resolve(pos[2] ?? 'out');
  const useAi = flags.has('--ai') && !!process.env['ANTHROPIC_API_KEY'];

  const report = await buildQbrReport(storeDataSource(), clientId, period, {
    narrativeModel: useAi ? createClaudeNarrativeModel() : undefined,
    narrativeCache: narrativeCacheFor(getDataStore(), clientId, period),
    heldBy: 'Jason Mashni',
    generatedLabel: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
    ...(await loadReportInputs(getDataStore(), clientId, period)),
  });

  mkdirSync(outDir, { recursive: true });
  const html = renderQbrHtml(report);
  const htmlPath = resolve(outDir, `QBR-${clientId}-${period}.html`);
  writeFileSync(htmlPath, html, 'utf8');
  console.log(`HTML  -> ${htmlPath}`);

  try {
    const pdf = await renderPdf(report.model);
    const pdfPath = resolve(outDir, `QBR-${clientId}-${period}.pdf`);
    writeFileSync(pdfPath, pdf);
    console.log(`PDF   -> ${pdfPath}`);
  } catch (err) {
    console.log(`PDF   -> skipped (${err instanceof Error ? err.message : String(err)})`);
  }

  console.log(`Narrative: ${useAi ? 'Claude' : 'offline drafter'} · verified: ${report.narrative.verification.ok}`);
  if (report.warnings.length) console.log('Warnings:\n' + report.warnings.map((w) => '  - ' + w).join('\n'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
