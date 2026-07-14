"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CollaboratorAvatarStack } from "@/components/documents/collaborator-avatar-stack";
import { ShareDialog } from "@/components/documents/share-dialog";
import type { Collaborator } from "@sync-flow/schemas";

export interface DocumentHeaderProps {
  documentId: string;
  title: string | null;
  collaborators: Collaborator[];
  canEditTitle: boolean;
  onTitleCommit: (title: string) => void;
}

/**
 * Sticky editor header: back nav, editable title, connection pill, collaborator avatars, share.
 * Connection state is hardcoded "Saved" for now — Prompt 19 wires it to the real WebSocket state
 * in `useDocumentStore.connectionState`.
 */
export function DocumentHeader({
  documentId,
  title,
  collaborators,
  canEditTitle,
  onTitleCommit,
}: DocumentHeaderProps) {
  const router = useRouter();
  const [shareOpen, setShareOpen] = useState(false);
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
      <header className="sticky top-0 z-20 flex h-[65px] items-center gap-3 border-b border-border bg-background px-4">
        <Button
          variant="ghost"
          size="icon"
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

        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Saved
        </span>

        <CollaboratorAvatarStack collaborators={collaborators} />

        <Button
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5"
          onClick={() => setShareOpen(true)}
        >
          <Share2 className="h-3.5 w-3.5" />
          Share
        </Button>
      </header>

      <ShareDialog
        documentId={documentId}
        documentTitle={title ?? ""}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
    </>
  );
}
