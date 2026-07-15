import type { Metadata } from "next";
import { cookies } from "next/headers";

// Must match apps/server/src/auth/cookies.ts's ACCESS_TOKEN_COOKIE (see middleware.ts's own
// copy of this constant — no shared module between the edge middleware, this server component,
// and the API, so all three note the name explicitly rather than silently drifting apart).
const ACCESS_TOKEN_COOKIE = "access_token";

const FALLBACK_METADATA: Metadata = {
  title: "Document — SyncFlow",
  description: "A real-time collaborative document editor.",
};

/** Best-effort server-side title lookup for the browser tab / link-preview card. Never throws —
 * an unauthenticated visitor, an expired token, or a network hiccup all just fall back to a
 * generic title; `useDocumentEditor`'s client-side title effect corrects it once the page loads. */
async function fetchDocumentTitle(id: string): Promise<string | null> {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL;
  const token = cookies().get(ACCESS_TOKEN_COOKIE)?.value;
  if (!baseUrl || !token) return null;

  try {
    const res = await fetch(`${baseUrl}/api/v1/documents/${id}`, {
      headers: { Cookie: `${ACCESS_TOKEN_COOKIE}=${token}` },
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const title = (data as { document?: { title?: unknown } }).document?.title;
    return typeof title === "string" && title.length > 0 ? title : null;
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const title = await fetchDocumentTitle(params.id);
  if (!title) return FALLBACK_METADATA;

  const pageTitle = `${title} — SyncFlow`;
  const description = `Collaborate in real time on "${title}" with SyncFlow.`;
  return {
    title: pageTitle,
    description,
    openGraph: { title: pageTitle, description },
  };
}

export default function DocumentLayout({ children }: { children: React.ReactNode }) {
  return children;
}
