"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { EditorContent } from "@tiptap/react";
import { AlertCircle } from "lucide-react";
import { ApiError } from "@sync-flow/schemas";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DocumentHeader } from "@/components/editor/document-header";
import { FixedToolbar } from "@/components/editor/fixed-toolbar";
import { FloatingToolbar } from "@/components/editor/floating-toolbar";
import { MobileFormatSheet } from "@/components/editor/mobile-format-sheet";
import { useDocumentEditor } from "@/hooks/use-document-editor";
import { useDocumentDetail } from "@/hooks/use-document-sharing";
import { usePatchDocument } from "@/hooks/use-documents";
import { useRequireAuth } from "@/hooks/use-auth";
import { useKeyboardSafeCaret } from "@/hooks/use-keyboard-safe-caret";

export default function DocumentEditorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user, isLoading: authLoading } = useRequireAuth();
  const { data, isLoading, isError, error, refetch } = useDocumentDetail(
    id,
    !authLoading && Boolean(user),
  );
  const patchDocument = usePatchDocument(id);
  const { editor, connectionState, isSaving, activeUsers, joinAnnouncement } = useDocumentEditor({
    documentId: id,
    user,
    enabled: !authLoading && Boolean(user),
  });

  const role: "owner" | "editor" | "viewer" | null =
    !data || !user
      ? null
      : data.document.ownerId === user.id
        ? "owner"
        : (data.members.find((m) => m.userId === user.id)?.role ?? "viewer");
  const canEdit = role !== "viewer";

  useEffect(() => {
    editor?.setEditable(canEdit);
  }, [editor, canEdit]);

  useKeyboardSafeCaret(editor);

  // Keep the browser tab in sync with the doc's title (rename, or the server-rendered
  // placeholder resolving to the real title on first load) — generateMetadata's SSR <title>
  // only covers the very first paint / link previews, not a live in-session rename.
  useEffect(() => {
    if (data?.document.title) document.title = `${data.document.title} — SyncFlow`;
  }, [data?.document.title]);

  if (isError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-muted-foreground">
          {error instanceof ApiError
            ? (error.detail ?? error.title)
            : "Couldn't load this document. It may not exist, or you may not have access."}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => refetch()}>
            Retry
          </Button>
          <Button onClick={() => router.push("/documents")}>Back to documents</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <DocumentHeader
        documentId={id}
        title={isLoading || !data ? null : data.document.title}
        connectionState={connectionState}
        isSaving={isSaving}
        activeUsers={activeUsers}
        joinAnnouncement={joinAnnouncement}
        selfId={user?.id}
        canEditTitle={canEdit}
        isOwner={role === "owner"}
        onTitleCommit={(title) => patchDocument.mutate({ title })}
      />
      <FixedToolbar editor={editor} />
      <FloatingToolbar editor={editor} />
      <MobileFormatSheet editor={editor} />

      <main className="flex-1">
        <div className="mx-auto max-w-3xl px-4 pb-24 pt-8 sm:px-8 sm:pt-16">
          {isLoading || !editor ? (
            <div className="space-y-4">
              <Skeleton className="h-7 w-2/3" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-4/5" />
            </div>
          ) : (
            <EditorContent editor={editor} />
          )}
        </div>
      </main>
    </div>
  );
}
