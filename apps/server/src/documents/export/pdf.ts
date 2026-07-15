/**
 * Headless-Chromium PDF renderer. Uses `puppeteer-core` + `@sparticuz/chromium` (a
 * lightweight, brotli-compressed Chromium that runs in server/serverless environments
 * like Railway without bundling the full 300MB Puppeteer download).
 *
 * The browser is launched lazily and reused across requests — spinning up Chromium is
 * the expensive part (hundreds of ms), so we pay it once and open a fresh page per
 * render. `closePdfBrowser()` is wired into the server's graceful-shutdown path.
 */

import chromium from "@sparticuz/chromium";
import puppeteer, { type Browser } from "puppeteer-core";

/** Renders a full HTML document to a PDF buffer. Injectable so routes/tests can fake it. */
export type PdfRenderer = (html: string) => Promise<Buffer>;

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        args: chromium.args,
        executablePath: await chromium.executablePath(),
        headless: true,
      })
      .catch((err: unknown) => {
        // A failed launch must not poison the cached promise — clear it so the next
        // request retries a fresh launch instead of re-rejecting forever.
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

export const renderPdf: PdfRenderer = async (html) => {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    // Let the Google Fonts webfont finish loading before printing so text isn't rendered
    // in the fallback face. `document.fonts.ready` resolves even when the CDN is
    // unreachable (the CSS font-family just falls back), so an offline box degrades to the
    // system font rather than hanging.
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
};

export async function closePdfBrowser(): Promise<void> {
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = null;
  try {
    const browser = await pending;
    await browser.close();
  } catch {
    // Best-effort teardown during shutdown — nothing actionable if the browser is already gone.
  }
}
