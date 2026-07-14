/**
 * Only allow same-origin, path-relative redirects. A bare `startsWith("/")` check isn't enough —
 * `//evil.com` and `/\evil.com` both parse as protocol-relative URLs in a browser, so those are
 * rejected too.
 */
export function safeRedirectPath(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  if (!candidate.startsWith("/")) return null;
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) return null;
  return candidate;
}
