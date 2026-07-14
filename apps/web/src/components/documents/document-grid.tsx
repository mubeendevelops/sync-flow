"use client";

import { useEffect, useRef } from "react";
import { AlertCircle, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DocumentCard } from "@/components/documents/document-card";
import { DocumentCardSkeleton } from "@/components/documents/document-card-skeleton";
import { CreateDocumentCard } from "@/components/documents/create-document-card";
import { useCreateDocumentAndNavigate, useDocumentsInfinite } from "@/hooks/use-documents";
import { ApiError } from "@sync-flow/schemas";

const GRID_CLASSES = "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3";

export function DocumentGrid() {
  const {
    data,
    isLoading,
    isError,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = useDocumentsInfinite();
  const sentinelRef = useRef<HTMLDivElement | null>(null);

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

  if (isLoading) {
    return (
      <div className={GRID_CLASSES}>
        {Array.from({ length: 6 }, (_, i) => (
          <DocumentCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-muted-foreground">
          {error instanceof ApiError
            ? (error.detail ?? error.title)
            : "Couldn't load your documents."}
        </p>
        <Button variant="outline" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const documents = data?.pages.flatMap((page) => page.documents) ?? [];

  if (documents.length === 0) {
    return <EmptyState />;
  }

  return (
    <div>
      <div className={GRID_CLASSES}>
        <CreateDocumentCard />
        {documents.map((doc) => (
          <DocumentCard key={doc.id} doc={doc} />
        ))}
      </div>
      {hasNextPage && (
        <div ref={sentinelRef} className="flex justify-center py-8">
          {isFetchingNextPage && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  const { create, isPending } = useCreateDocumentAndNavigate();

  return (
    <div className="flex flex-col items-center gap-4 py-24 text-center">
      <FileText className="h-10 w-10 text-muted-foreground" />
      <div>
        <h2 className="text-lg font-semibold text-foreground">No documents yet</h2>
        <p className="mt-1 text-muted-foreground">Create your first document to start writing.</p>
      </div>
      <Button size="lg" onClick={create} disabled={isPending}>
        Create your first document
      </Button>
    </div>
  );
}
