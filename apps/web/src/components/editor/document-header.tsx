"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, History, Loader2, Share2, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PresenceAvatarStack } from "@/components/documents/presence-avatar-stack";
import { ShareDialog } from "@/components/documents/share-dialog";
import { VersionHistoryPanel } from "@/components/documents/version-history-panel";
import { toSavedState, type SavedState } from "@/lib/connection-status";
import type { ConnectionState, PresenceUser } from "@/lib/websocket";
import { cn } from "@/lib/utils";

const SAVED_STATE_CONFIG: Record<
  SavedState,
  { label: string; icon: typeof CheckCircle2; spin?: boolean; className: string }
> = {
  saved: {
    label: "Saved",
    icon: CheckCircle2,
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  saving: {
    label: "Saving…",
    icon: Loader2,
    spin: true,
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  reconnecting: {
    label: "Reconnecting…",
    icon: Loader2,
    spin: true,
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  offline: {
    label: "Offline — edits saved locally",
    icon: WifiOff,
    className: "bg-destructive/10 text-destructive",
  },
};

/** The header's connection/save pill — exactly the four states from CLAUDE.md's polish spec,
 * announced via `role="status"` so a screen reader hears every transition. */
function ConnectionPill({
  connectionState,
  isSaving,
}: {
  connectionState: ConnectionState;
  isSaving: boolean;
}) {
  const state = toSavedState(connectionState, isSaving);
  const { label, icon: Icon, spin, className } = SAVED_STATE_CONFIG[state];

  return (
    <span
      role="status"
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        className,
      )}
    >
      <Icon aria-hidden className={cn("h-3.5 w-3.5 shrink-0", spin && "animate-spin")} />
      {/* The full copy (e.g. "Offline — edits saved locally") is always in the DOM for screen
          readers; visually it's clipped on narrow viewports so the header doesn't overflow. */}
      <span className="max-w-[72px] truncate sm:max-w-none">{label}</span>
    </span>
  );
}

export interface DocumentHeaderProps {
  documentId: string;
  title: string | null;
  connectionState: ConnectionState;
  /** True while at least one edit ack is outstanding. */
  isSaving: boolean;
  /** Users currently in the document (live presence), for the avatar stack. */
  activeUsers: PresenceUser[];
  /** Latest "X joined" text, announced to screen readers via `aria-live="polite"`. */
  joinAnnouncement?: string;
  /** The viewing user's id, so their own presence row is marked "you". */
  selfId?: string;
  canEditTitle: boolean;
  /** Only the owner can restore a version — gates the restore button in the history panel. */
  isOwner: boolean;
  onTitleCommit: (title: string) => void;
}

/**
 * Sticky editor header: back nav, editable title, connection pill, live-presence avatars, share.
 */
export function DocumentHeader({
  documentId,
  title,
  connectionState,
  isSaving,
  activeUsers,
  joinAnnouncement,
  selfId,
  canEditTitle,
  isOwner,
  onTitleCommit,
}: DocumentHeaderProps) {
  const router = useRouter();
  const [shareOpen, setShareOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const lastCommittedTitle = useRef(title);

  useEffect(() => {
    // Only reflect external title changes (e.g. after a fetch) — never fight the DOM while the
    // user is actively editing the contenteditable h1.
    if (title !== null && titleRef.current && document.activeElement !== titleRef.current) {
      titleRef.current.textContent = title;
      lastCommittedTitle.current = title;
    }
  }, [title]);

  function handleTitleBlur(e: React.FocusEvent<HTMLHeadingElement>) {
    const next = e.currentTarget.textContent?.trim() ?? "";
    if (!next) {
      e.currentTarget.textContent = lastCommittedTitle.current ?? "";
      return;
    }
    if (next !== lastCommittedTitle.current) {
      lastCommittedTitle.current = next;
      onTitleCommit(next);
    }
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLHeadingElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.currentTarget.textContent = lastCommittedTitle.current ?? "";
      e.currentTarget.blur();
    }
  }

  return (
    <>
      {/* Screen-reader-only companion to the "X joined" toast — sighted users get the toast,
          everyone else gets this polite live-region announcement. */}
      <div role="status" aria-live="polite" className="sr-only">
        {joinAnnouncement}
      </div>

      <header className="sticky top-0 z-20 flex h-[65px] items-center gap-1.5 border-b border-border bg-background px-2 sm:gap-3 sm:px-4">
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          aria-label="Back to documents"
          onClick={() => router.push("/documents")}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        {title === null ? (
          <Skeleton className="h-6 w-48" />
        ) : (
          <h1
            ref={titleRef}
            contentEditable={canEditTitle}
            suppressContentEditableWarning
            onBlur={handleTitleBlur}
            onKeyDown={handleTitleKeyDown}
            className="min-w-0 flex-1 truncate rounded px-1 text-lg font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {title}
          </h1>
        )}

        <ConnectionPill connectionState={connectionState} isSaving={isSaving} />

        <PresenceAvatarStack users={activeUsers} selfId={selfId} />

        <Button
          variant="outline"
          size="sm"
          aria-label="History"
          className="shrink-0 gap-1.5 px-2 sm:px-3"
          onClick={() => setHistoryOpen(true)}
        >
          <History className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">History</span>
        </Button>

        <Button
          variant="outline"
          size="sm"
          aria-label="Share"
          className="shrink-0 gap-1.5 px-2 sm:px-3"
          onClick={() => setShareOpen(true)}
        >
          <Share2 className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Share</span>
        </Button>
      </header>

      <ShareDialog
        documentId={documentId}
        documentTitle={title ?? ""}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />

      <VersionHistoryPanel
        documentId={documentId}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        canRestore={isOwner}
      />
    </>
  );
}
