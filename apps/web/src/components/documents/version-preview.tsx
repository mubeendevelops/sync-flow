"use client";

import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { format } from "date-fns";
import { AlertCircle, ArrowLeft, RotateCcw } from "lucide-react";
import { ApiError, type VersionListItem } from "@sync-flow/schemas";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useVersionPreview } from "@/hooks/use-document-versions";

// Same "\n"-joined block convention as the live editor's CRDT projection (see
// lib/text-projection.ts) — a reconstructed version is always plaintext, never marks.
const PREVIEW_EDITOR_CLASS =
  "prose dark:prose-invert max-w-none text-[15px] leading-[1.7] [&_p]:leading-[1.7]";

function textToDocContent(text: string) {
  const lines = text.length === 0 ? [""] : text.split("\n");
  return {
    type: "doc",
    content: lines.map((line) => ({
      type: "paragraph",
      content: line.length > 0 ? [{ type: "text", text: line }] : [],
    })),
  };
}

export interface VersionPreviewProps {
  documentId: string;
  version: VersionListItem;
  /** Mobile only — returns to the version list (see `VersionHistoryPanel`'s master/detail
   * layout, where this pane replaces the list instead of sitting beside it below `sm`). */
  onBack: () => void;
  canRestore: boolean;
  onRequestRestore: () => void;
  restorePending: boolean;
}

/** Read-only right-hand pane of the history panel: the reconstructed text of one version. */
export function VersionPreview({
  documentId,
  version,
  onBack,
  canRestore,
  onRequestRestore,
  restorePending,
}: VersionPreviewProps) {
  const { data, isLoading, isError, error, refetch } = useVersionPreview(
    documentId,
    version.version,
  );

  const editor = useEditor({
    immediatelyRender: false,
    editable: false,
    extensions: [Document, Paragraph, Text],
    editorProps: { attributes: { class: PREVIEW_EDITOR_CLASS, "aria-label": "Version preview" } },
  });

  useEffect(() => {
    if (editor && data) editor.commands.setContent(textToDocContent(data.text));
  }, [editor, data]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="flex min-w-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back to version list"
            className="-ml-2 h-8 w-8 shrink-0 sm:hidden"
            onClick={onBack}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="truncate text-sm text-muted-foreground">
            {format(new Date(version.createdAt), "PPp")}
          </span>
        </div>
        {canRestore && (
          <Button
            size="sm"
            className="shrink-0 gap-1.5"
            disabled={restorePending}
            onClick={onRequestRestore}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Restore<span className="hidden sm:inline">&nbsp;this version</span>
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-4/5" />
          </div>
        )}

        {isError && (
          <div className="flex flex-col items-center gap-3 pt-12 text-center">
            <AlertCircle className="h-6 w-6 text-destructive" />
            <p className="text-sm text-muted-foreground">
              {error instanceof ApiError
                ? (error.detail ?? error.title)
                : "Couldn't load this version."}
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        )}

        {!isLoading && !isError && <EditorContent editor={editor} />}
      </div>
    </div>
  );
}
