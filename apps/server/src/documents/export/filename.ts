/**
 * Build a `Content-Disposition: attachment` header value for a downloaded file.
 *
 * The document title is user-controlled, so it must never be dropped verbatim into the
 * header — a quote or newline would break header parsing (or worse, allow injection). We
 * emit both a sanitized ASCII `filename=` (the safe fallback every client understands) and
 * an RFC 5987 `filename*` (UTF-8 percent-encoded) so titles with non-ASCII characters keep
 * their real name in clients that support it.
 */

/* eslint-disable no-control-regex */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
const HEADER_HOSTILE = /["\\/:*?<>|]/g;
const NON_ASCII = /[^\x20-\x7e]/g;
/* eslint-enable no-control-regex */

/** Collapse a title into a safe ASCII filename stem — no quotes, slashes, or control chars. */
function asciiStem(title: string): string {
  const cleaned = title
    .replace(CONTROL_CHARS, "")
    .replace(HEADER_HOSTILE, "")
    .replace(NON_ASCII, "") // drop remaining non-ASCII (the filename* carries those)
    .trim()
    .slice(0, 100)
    .trim();
  return cleaned || "document";
}

export function pdfContentDisposition(title: string): string {
  const stem = asciiStem(title);
  const utf8Stem = title.replace(CONTROL_CHARS, "").trim().slice(0, 100).trim() || "document";
  const encoded = encodeURIComponent(`${utf8Stem}.pdf`);
  return `attachment; filename="${stem}.pdf"; filename*=UTF-8''${encoded}`;
}
