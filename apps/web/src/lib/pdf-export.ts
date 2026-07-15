/**
 * Download the current document as a PDF from the server's `GET /export/pdf` endpoint.
 *
 * The shared `apiClient` parses JSON responses, but this endpoint streams a binary PDF, so
 * we fetch it directly — still cookie-authenticated (`credentials: "include"`, matching the
 * rest of the app's httpOnly-cookie auth) — read it as a Blob, and trigger a browser
 * download via an object URL. A GET needs no CSRF token.
 */

const baseUrl = process.env.NEXT_PUBLIC_API_URL;

/** Prefer the server's Content-Disposition filename; fall back to the document title. */
function filenameFrom(header: string | null, fallbackTitle: string): string {
  if (header) {
    const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (utf8?.[1]) {
      try {
        return decodeURIComponent(utf8[1]);
      } catch {
        // fall through to the ASCII filename
      }
    }
    const ascii = /filename="([^"]+)"/i.exec(header);
    if (ascii?.[1]) return ascii[1];
  }
  const stem = fallbackTitle.trim() || "document";
  return `${stem}.pdf`;
}

export async function downloadDocumentPdf(documentId: string, title: string): Promise<void> {
  if (!baseUrl) throw new Error("NEXT_PUBLIC_API_URL is not set");

  const res = await fetch(`${baseUrl}/api/v1/documents/${documentId}/export/pdf`, {
    method: "GET",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`Export failed (${res.status})`);
  }

  const blob = await res.blob();
  const filename = filenameFrom(res.headers.get("content-disposition"), title);

  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
