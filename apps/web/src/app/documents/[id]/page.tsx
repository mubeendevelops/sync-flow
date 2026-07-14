"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { EditorContent } from "@tiptap/react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DocumentHeader } from "@/components/editor/document-header";
import { FixedToolbar } from "@/components/editor/fixed-toolbar";
import { FloatingToolbar } from "@/components/editor/floating-toolbar";
import { useDocumentEditor } from "@/hooks/use-document-editor";
import { useDocumentDetail } from "@/hooks/use-document-sharing";
import { usePatchDocument } from "@/hooks/use-documents";
import { useRequireAuth } from "@/hooks/use-auth";
import type { Collaborator } from "@sync-flow/schemas";

export default function DocumentEditorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user, isLoading: authLoading } = useRequireAuth();
  const { data, isLoading, isError } = useDocumentDetail(id, !authLoading && Boolean(user));
  const patchDocument = usePatchDocument(id);
  const { editor } = useDocumentEditor();

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

  if (isError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
        <p className="text-muted-foreground">
          Couldn&apos;t load this document. It may not exist, or you may not have access.
        </p>
        <Button variant="outline" onClick={() => router.push("/documents")}>
          Back to documents
        </Button>
      </div>
    );
  }

  const collaborators: Collaborator[] = data
    ? [
        ...(data.owner
          ? [
              {
                userId: data.owner.id,
                username: data.owner.username,
                displayName: data.owner.displayName,
                presenceColor: data.owner.presenceColor,
                role: "owner" as const,
              },
            ]
          : []),
        ...data.members,
      ]
    : [];

  return (
    <div className="flex min-h-screen flex-col">
      <DocumentHeader
        documentId={id}
        title={isLoading || !data ? null : data.document.title}
        collaborators={collaborators}
        canEditTitle={canEdit}
        onTitleCommit={(title) => patchDocument.mutate({ title })}
      />
      <FixedToolbar editor={editor} />
      <FloatingToolbar editor={editor} />

      <main className="flex-1">
        <div className="mx-auto max-w-3xl px-8 pb-24 pt-16">
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
