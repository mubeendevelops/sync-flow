"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ApiError,
  listVersionsResponseSchema,
  versionPreviewResponseSchema,
  restoreResponseSchema,
} from "@sync-flow/schemas";
import { apiClient } from "@/lib/api-client";

const VERSIONS_PAGE_SIZE = 20;

export function versionsQueryKey(documentId: string) {
  return ["documents", documentId, "versions"] as const;
}

/** Paginated version list (newest-first) driving the history panel's infinite scroll. */
export function useVersionsInfinite(documentId: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: versionsQueryKey(documentId),
    queryFn: ({ pageParam }) =>
      apiClient.get(`/api/v1/documents/${documentId}/versions`, {
        query: { cursor: pageParam, limit: VERSIONS_PAGE_SIZE },
        responseSchema: listVersionsResponseSchema,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled,
  });
}

/** Reconstructed text at a single version — fetched lazily, only once a version is selected. */
export function useVersionPreview(documentId: string, version: number | null) {
  return useQuery({
    queryKey: ["documents", documentId, "versions", version] as const,
    queryFn: () =>
      apiClient.get(`/api/v1/documents/${documentId}/versions/${version}`, {
        responseSchema: versionPreviewResponseSchema,
      }),
    enabled: version !== null,
  });
}

/** Owner-only restore — server appends a forward op diff, so connected editors (including this
 * tab's, if any) converge via the normal socket `operation` broadcast; this mutation only needs
 * to refresh the version list itself (the new restore-point + post-restore snapshots appear). */
export function useRestoreVersion(documentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (version: number) =>
      apiClient.post(`/api/v1/documents/${documentId}/restore/${version}`, {
        responseSchema: restoreResponseSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: versionsQueryKey(documentId) });
    },
    onError: (err) => {
      toast.error(
        err instanceof ApiError ? (err.detail ?? err.title) : "Couldn't restore that version.",
      );
    },
  });
}
