"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { AlertCircle, History as HistoryIcon, Loader2 } from "lucide-react";
import { ApiError, type VersionListItem } from "@sync-flow/schemas";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { getInitials } from "@/lib/initials";
import { cn } from "@/lib/utils";
import { useRestoreVersion, useVersionsInfinite } from "@/hooks/use-document-versions";
import { VersionPreview } from "@/components/documents/version-preview";

export interface VersionHistoryPanelProps {
  documentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Only the owner may restore (matches the server's owner-only restore route). */
  canRestore: boolean;
}

// No presenceColor comes back for a contributor (see versions.repo.ts) — a stable per-user hash
// into this palette gives each avatar a consistent color across renders without one.
const CONTRIBUTOR_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  return CONTRIBUTOR_COLORS[Math.abs(hash) % CONTRIBUTOR_COLORS.length]!;
}

export function VersionHistoryPanel({
  documentId,
  open,
  onOpenChange,
  canRestore,
}: VersionHistoryPanelProps) {
  const [selected, setSelected] = useState<VersionListItem | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useVersionsInfinite(documentId, open);
  const restoreVersion = useRestoreVersion(documentId);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Selection is scoped to one panel session — clear it whenever the sheet closes (by any
  // means: the X button, overlay click, Escape, or a caller-driven close) so reopening starts fresh.
  function handleOpenChange(next: boolean) {
    if (!next) setSelected(null);
    onOpenChange(next);
  }

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
        void fetchNextPage();
      }
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const versions = data?.pages.flatMap((page) => page.versions) ?? [];

  function handleRestore() {
    if (!selected) return;
    restoreVersion.mutate(selected.version, {
      onSuccess: () => {
        toast.success("Document restored");
        setConfirmRestore(false);
        handleOpenChange(false);
      },
    });
  }

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent side="right" className="flex w-full flex-col p-0 sm:max-w-3xl">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <HistoryIcon className="h-4 w-4" />
              Version history
            </SheetTitle>
            <SheetDescription>
              Every version is saved automatically. Select one to preview it.
            </SheetDescription>
          </SheetHeader>

          <div className="flex min-h-0 flex-1">
            {/* On mobile this is a master/detail flow, not side-by-side: the list takes the
                full screen until a version is selected, then the preview takes over (with a
                back button below). At `sm`+ both panes show at once, as before. */}
            <div
              className={cn(
                "flex w-full shrink-0 flex-col overflow-y-auto border-border sm:w-72 sm:border-r",
                selected && "hidden sm:flex",
              )}
            >
              {isLoading && (
                <div className="space-y-3 p-4">
                  {Array.from({ length: 5 }, (_, i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              )}

              {isError && (
                <div className="flex flex-col items-center gap-3 p-6 text-center">
                  <AlertCircle className="h-6 w-6 text-destructive" />
                  <p className="text-sm text-muted-foreground">
                    {error instanceof ApiError
                      ? (error.detail ?? error.title)
                      : "Couldn't load version history."}
                  </p>
                  <Button variant="outline" size="sm" onClick={() => refetch()}>
                    Retry
                  </Button>
                </div>
              )}

              {!isLoading && !isError && versions.length === 0 && (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  No versions yet — versions are saved automatically every 100 edits
                </p>
              )}

              {!isLoading && !isError && versions.length > 0 && (
                <ul>
                  {versions.map((v) => (
                    <VersionRow
                      key={v.version}
                      version={v}
                      selected={v.version === selected?.version}
                      onView={() => setSelected(v)}
                    />
                  ))}
                </ul>
              )}

              {hasNextPage && (
                <div ref={sentinelRef} className="flex justify-center py-4">
                  {isFetchingNextPage && (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  )}
                </div>
              )}
            </div>

            <div
              className={cn(
                "flex min-w-0 flex-1 flex-col",
                selected === null && "hidden sm:flex",
              )}
            >
              {selected === null ? (
                <div className="hidden flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground sm:flex">
                  Select a version to preview it here.
                </div>
              ) : (
                <VersionPreview
                  documentId={documentId}
                  version={selected}
                  onBack={() => setSelected(null)}
                  canRestore={canRestore}
                  onRequestRestore={() => setConfirmRestore(true)}
                  restorePending={restoreVersion.isPending}
                />
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmRestore} onOpenChange={setConfirmRestore}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this version?</AlertDialogTitle>
            <AlertDialogDescription>
              This will restore the document to this version. Your current content will be saved
              as a new version first. All collaborators will see the change immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={(e) => e.stopPropagation()}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={restoreVersion.isPending}
              onClick={(e) => {
                e.stopPropagation();
                handleRestore();
              }}
            >
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface VersionRowProps {
  version: VersionListItem;
  selected: boolean;
  onView: () => void;
}

function VersionRow({ version, selected, onView }: VersionRowProps) {
  const isRestoreRelated = version.kind === "restore_point" || version.kind === "post_restore";

  return (
    <li className={cn("border-b border-border px-4 py-3", selected && "bg-accent")}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">
          {formatDistanceToNow(new Date(version.createdAt), { addSuffix: true })}
        </span>
        {isRestoreRelated && (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {version.kind === "restore_point" ? "Restore point" : "Restored"}
          </Badge>
        )}
      </div>

      <p className="mt-1 truncate text-xs text-muted-foreground">
        {isRestoreRelated && version.label ? version.label : (version.preview || "(empty)")}
      </p>

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex -space-x-1.5">
          {version.contributors.slice(0, 4).map((c) => (
            <Avatar key={c.userId} className="h-5 w-5 ring-2 ring-background" title={c.displayName}>
              <AvatarFallback
                style={{ backgroundColor: colorForUser(c.userId) }}
                className="text-[9px]"
              >
                {getInitials(c.displayName)}
              </AvatarFallback>
            </Avatar>
          ))}
        </div>
        <Button
          variant={selected ? "secondary" : "outline"}
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onView}
        >
          View
        </Button>
      </div>
    </li>
  );
}
