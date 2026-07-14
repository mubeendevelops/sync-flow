import { PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { BackendStatus } from "@/components/backend-status";

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex items-center gap-2 font-semibold">
          <PenLine className="h-5 w-5 text-primary" />
          SyncFlow
        </div>
        <div className="flex items-center gap-4">
          <BackendStatus />
          <ThemeToggle />
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-6">
        <div className="max-w-xl text-center">
          <h1 className="text-4xl font-semibold tracking-tight text-foreground">
            Write together, in real time.
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
            SyncFlow is a Google-Docs-style collaborative editor built on a hand-rolled RGA CRDT —
            no Yjs, no Automerge. Sign in to start writing.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Button size="lg">Get started</Button>
            <Button size="lg" variant="outline">
              Sign in
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
