"use client";

import { Plus } from "lucide-react";
import { useCreateDocumentAndNavigate } from "@/hooks/use-documents";

export function CreateDocumentCard() {
  const { create, isPending } = useCreateDocumentAndNavigate();

  return (
    <button
      type="button"
      onClick={create}
      disabled={isPending}
      className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:pointer-events-none disabled:opacity-50"
    >
      <Plus className="h-6 w-6" />
      <span className="text-sm font-medium">New document</span>
    </button>
  );
}
