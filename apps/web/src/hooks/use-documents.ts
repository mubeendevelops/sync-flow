"use client";

import {
  useMutation,
  useQueryClient,
  useInfiniteQuery,
  type InfiniteData,
} from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  createDocumentResponseSchema,
  listDocumentsResponseSchema,
  patchDocumentResponseSchema,
  type CreateDocumentBody,
  type DocumentListItem,
  type ListDocumentsResponse,
  type PatchDocumentBody,
} from "@sync-flow/schemas";
import { apiClient } from "@/lib/api-client";
import { useAuthStore } from "@/stores/auth-store";

export const DOCUMENTS_LIST_QUERY_KEY = ["documents", "list"] as const;

const PAGE_SIZE = 20;

/** Marks the optimistic placeholder card inserted by useCreateDocument — never present in a
 * real API response, so `doc.pending` alone is enough to detect it in the UI. */
export interface OptimisticDocumentListItem extends DocumentListItem {
  pending?: boolean;
}

type DocumentsPages = InfiniteData<ListDocumentsResponse, number>;

export function useDocumentsInfinite() {
  return useInfiniteQuery({
    queryKey: DOCUMENTS_LIST_QUERY_KEY,
    queryFn: ({ pageParam }) =>
      apiClient.get("/api/v1/documents", {
        query: { page: pageParam, pageSize: PAGE_SIZE },
        responseSchema: listDocumentsResponseSchema,
      }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const loaded = lastPage.pagination.page * lastPage.pagination.pageSize;
      return loaded < lastPage.pagination.total ? lastPage.pagination.page + 1 : undefined;
    },
  });
}

function withFirstPagePatched(
  data: DocumentsPages | undefined,
  patch: (documents: OptimisticDocumentListItem[]) => OptimisticDocumentListItem[],
): DocumentsPages | undefined {
  const firstPage = data?.pages[0];
  if (!data || !firstPage) return data;
  const [, ...rest] = data.pages;
  return { ...data, pages: [{ ...firstPage, documents: patch(firstPage.documents) }, ...rest] };
}

/** Optimistic: an in-flight placeholder card appears immediately; on success the caller
 * navigates to the new document (the list itself is invalidated in the background so it's
 * accurate whenever the user comes back to it). On failure, rolls back and toasts. */
export function useCreateDocument() {
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);

  return useMutation({
    mutationFn: (body: CreateDocumentBody) =>
      apiClient.post("/api/v1/documents", { body, responseSchema: createDocumentResponseSchema }),
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: DOCUMENTS_LIST_QUERY_KEY });
      const previous = queryClient.getQueryData<DocumentsPages>(DOCUMENTS_LIST_QUERY_KEY);
      const tempId = `temp-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const optimisticDoc: OptimisticDocumentListItem = {
        id: tempId,
        title: body.title,
        ownerId: currentUser?.id ?? "",
        isPublic: false,
        createdAt: now,
        updatedAt: now,
        role: "owner",
        collaborators: currentUser
          ? [
              {
                userId: currentUser.id,
                username: currentUser.username,
                displayName: currentUser.displayName,
                presenceColor: currentUser.presenceColor,
                role: "owner",
              },
            ]
          : [],
        pending: true,
      };
      queryClient.setQueryData<DocumentsPages>(DOCUMENTS_LIST_QUERY_KEY, (old) =>
        withFirstPagePatched(old, (documents) => [optimisticDoc, ...documents]),
      );
      return { previous, tempId };
    },
    onError: (_err, _body, context) => {
      if (context?.previous) {
        queryClient.setQueryData(DOCUMENTS_LIST_QUERY_KEY, context.previous);
      }
      toast.error("Couldn't create the document. Please try again.");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DOCUMENTS_LIST_QUERY_KEY });
    },
  });
}

const DEFAULT_DOCUMENT_TITLE = "Untitled document";

/** Shared by the "+ New document" tile and the empty-state CTA — create with a default title,
 * then navigate to the editor on success. */
export function useCreateDocumentAndNavigate() {
  const router = useRouter();
  const createDocument = useCreateDocument();

  return {
    create: () =>
      createDocument.mutate(
        { title: DEFAULT_DOCUMENT_TITLE },
        { onSuccess: ({ document }) => router.push(`/documents/${document.id}`) },
      ),
    isPending: createDocument.isPending,
  };
}

/** Rename and/or toggle-public. Used by the card's inline title editor (debounced by the
 * caller) and, later, the editor header. */
export function usePatchDocument(documentId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: PatchDocumentBody) =>
      apiClient.patch(`/api/v1/documents/${documentId}`, {
        body,
        responseSchema: patchDocumentResponseSchema,
      }),
    onSuccess: ({ document }) => {
      queryClient.setQueryData<DocumentsPages>(DOCUMENTS_LIST_QUERY_KEY, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            documents: page.documents.map((doc) =>
              doc.id === documentId ? { ...doc, ...document } : doc,
            ),
          })),
        };
      });
    },
    onError: () => {
      toast.error("Couldn't save that change. Please try again.");
    },
  });
}

export function useDeleteDocument() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (documentId: string) => apiClient.delete(`/api/v1/documents/${documentId}`),
    onSuccess: (_data, documentId) => {
      queryClient.setQueryData<DocumentsPages>(DOCUMENTS_LIST_QUERY_KEY, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            documents: page.documents.filter((doc) => doc.id !== documentId),
            pagination: { ...page.pagination, total: Math.max(0, page.pagination.total - 1) },
          })),
        };
      });
    },
    onError: () => {
      toast.error("Couldn't delete the document. Please try again.");
    },
  });
}
