"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { Loader2, MoreVertical, Share2, Trash2 } from "lucide-react";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CollaboratorAvatarStack } from "@/components/documents/collaborator-avatar-stack";
import { DeleteDocumentDialog } from "@/components/documents/delete-document-dialog";
import { ShareDialog } from "@/components/documents/share-dialog";
import { usePatchDocument } from "@/hooks/use-documents";
import { useDebouncedCallback } from "@/hooks/use-debounce";
import type { OptimisticDocumentListItem } from "@/hooks/use-documents";

const RENAME_DEBOUNCE_MS = 400;

export function DocumentCard({ doc }: { doc: OptimisticDocumentListItem }) {
  const router = useRouter();
  const patchDocument = usePatchDocument(doc.id);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(doc.title);
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const skipNextCommitRef = useRef(false);

  const canManage = doc.role === "owner" && !doc.pending;

  const commitRename = useDebouncedCallback((title: string) => {
    const trimmed = title.trim();
    if (trimmed && trimmed !== doc.title) {
      patchDocument.mutate({ title: trimmed });
    }
  }, RENAME_DEBOUNCE_MS);

  function startEditing(e: React.MouseEvent) {
    if (!canManage) return;
    e.stopPropagation();
    setTitleDraft(doc.title);
    setIsEditingTitle(true);
  }

  function finishEditing() {
    setIsEditingTitle(false);
    if (!skipNextCommitRef.current) commitRename(titleDraft);
    skipNextCommitRef.current = false;
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      skipNextCommitRef.current = true;
      setTitleDraft(doc.title);
      e.currentTarget.blur();
    }
  }

  function openDocument() {
    if (doc.pending) return;
    router.push(`/documents/${doc.id}`);
  }

  return (
    <>
      <Card
        role="link"
        tabIndex={doc.pending ? -1 : 0}
        aria-label={`Open ${doc.title}`}
        onClick={openDocument}
        onKeyDown={(e) => {
          if (e.key === "Enter") openDocument();
        }}
        className={
          doc.pending
            ? "opacity-70"
            : "cursor-pointer transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        }
      >
        <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
          <div className="min-w-0 flex-1">
            {isEditingTitle ? (
              <Input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={finishEditing}
                onKeyDown={handleTitleKeyDown}
                onClick={(e) => e.stopPropagation()}
                className="h-7 px-1 text-base font-semibold"
              />
            ) : (
              <button
                type="button"
                onClick={startEditing}
                disabled={!canManage}
                className="truncate text-left text-base font-semibold text-foreground disabled:cursor-default"
                title={canManage ? "Click to rename" : doc.title}
              >
                {doc.title}
              </button>
            )}
            {doc.role !== "owner" && (
              <Badge variant="outline" className="mt-1.5 capitalize">
                {doc.role}
              </Badge>
            )}
          </div>

          {doc.pending ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={(e) => e.stopPropagation()}
                  aria-label="Document actions"
                >
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem onSelect={() => setShareOpen(true)}>
                  <Share2 className="mr-2 h-4 w-4" />
                  Share
                </DropdownMenuItem>
                {canManage && (
                  <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </CardHeader>

        <CardContent>
          <p className="text-sm text-muted-foreground">
            {doc.pending
              ? "Creating…"
              : `Edited ${formatDistanceToNow(new Date(doc.updatedAt), { addSuffix: true })}`}
          </p>
        </CardContent>

        <CardFooter>
          <CollaboratorAvatarStack collaborators={doc.collaborators} />
        </CardFooter>
      </Card>

      {!doc.pending && (
        <>
          <ShareDialog
            documentId={doc.id}
            documentTitle={doc.title}
            open={shareOpen}
            onOpenChange={setShareOpen}
          />
          <DeleteDocumentDialog
            documentId={doc.id}
            documentTitle={doc.title}
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
          />
        </>
      )}
    </>
  );
}
