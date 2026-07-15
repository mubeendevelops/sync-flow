/**
 * Redis cache for rendered PDFs, keyed by document + content version. Rendering a PDF
 * launches Chromium and prints a page — expensive enough to be worth skipping when the
 * document hasn't changed. The version is the CRDT op watermark (highest seq folded into
 * the hydrated doc), so any edit bumps it and naturally invalidates the entry; a stale or
 * missing cache is only ever a performance miss, never a correctness one.
 *
 * Buffers are stored base64-encoded (Redis strings are binary-safe, but base64 keeps the
 * value plain-text across every client/inspector) with a 1h TTL.
 */

import type { CrdtStateCache } from "../../crdt-service/index.js";

const PDF_CACHE_TTL_SECONDS = 60 * 60; // 1h

function pdfKey(documentId: string, version: number): string {
  return `pdf:${documentId}:${version}`;
}

export async function readCachedPdf(
  cache: CrdtStateCache,
  documentId: string,
  version: number,
): Promise<Buffer | null> {
  const raw = await cache.get(pdfKey(documentId, version));
  if (!raw) return null;
  try {
    return Buffer.from(raw, "base64");
  } catch {
    return null;
  }
}

export async function writeCachedPdf(
  cache: CrdtStateCache,
  documentId: string,
  version: number,
  pdf: Buffer,
): Promise<void> {
  await cache.set(pdfKey(documentId, version), pdf.toString("base64"), {
    EX: PDF_CACHE_TTL_SECONDS,
  });
}
