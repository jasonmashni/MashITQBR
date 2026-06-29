/**
 * Branded PDF generation by printing the report HTML with headless Chromium.
 * Playwright is an optional peer dependency, imported dynamically so the package
 * builds and unit-tests without it. The API app installs Playwright and points
 * `executablePath` at the preinstalled Chromium when running in Azure.
 */
export interface PdfOptions {
  format?: 'Letter' | 'A4';
  /** Path to a Chromium binary (e.g. the preinstalled /opt/pw-browsers/chromium). */
  executablePath?: string;
}

export async function renderPdf(html: string, opts: PdfOptions = {}): Promise<Buffer> {
  // Variable specifier avoids a hard compile-time dependency on the optional lib.
  const spec = 'playwright';
  let playwright: any;
  try {
    playwright = await import(spec);
  } catch {
    throw new Error("renderPdf requires the optional 'playwright' dependency. Install it to enable PDF export.");
  }

  const launchOpts: Record<string, unknown> = {};
  const exe = opts.executablePath ?? process.env['PLAYWRIGHT_CHROMIUM_PATH'];
  if (exe) launchOpts['executablePath'] = exe;

  const browser = await playwright.chromium.launch(launchOpts);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    // Ensure web fonts are ready before printing so the PDF isn't laid out with fallbacks.
    // `document` lives in the browser context; reference it via globalThis to avoid the DOM lib.
    await page.evaluate(() => (globalThis as any).document?.fonts?.ready);
    const pdf = await page.pdf({ format: opts.format ?? 'Letter', printBackground: true });
    return pdf as Buffer;
  } finally {
    await browser.close();
  }
}
