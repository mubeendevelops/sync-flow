"use client";

import "./globals.css";

/**
 * Catches errors thrown by the root layout itself (Providers, theme setup, etc.), which
 * app/error.tsx can't reach — this is the effective "500 page". Renders its own html/body
 * since it replaces the whole root layout when it triggers.
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground">
        <h1 className="text-2xl font-semibold">SyncFlow hit a snag</h1>
        <p className="max-w-md text-muted-foreground">
          A critical error prevented the app from loading. Reloading usually fixes it.
        </p>
        <button
          onClick={() => reset()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Reload
        </button>
      </body>
    </html>
  );
}
