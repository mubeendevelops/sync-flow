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
  type Document,
  type DocumentListItem,
  type GetDocumentResponse,
  type ListDocumentsResponse,
  type PatchDocumentBody,
} from "@sync-flow/schemas";
import { apiClient } from "@/lib/api-client";
import { useAuthStore } from "@/stores/auth-store";

export const DOCUMENTS_LIST_QUERY_KEY = ["documents", "list"] as const;

export function documentDetailQueryKey(documentId: string) {
  return ["documents", "detail", documentId] as const;
}

const PAGE_SIZE = 20;

/** Marks the optimistic placeholder card inserted by useCreateDocument — never present in a
 * real API response, so `doc.pending` alone is enough to detect it in the UI. */
export interface OptimisticDocumentListItem extends DocumentListItem {
  pending?: boolean;
}

export type DocumentsPages = InfiniteData<ListDocumentsResponse, number>;

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

/** Unlike {@link withFirstPagePatched} (which only ever inserts onto page 0), a rename/patch can
 * target a document sitting on any loaded page — so this walks every page's document list.
 * Exported for the sharing hooks, which patch a doc's `collaborators` the same way. */
export function withDocumentPatched(
  data: DocumentsPages | undefined,
  documentId: string,
  patch: (doc: OptimisticDocumentListItem) => OptimisticDocumentListItem,
): DocumentsPages | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      documents: page.documents.map((doc) => (doc.id === documentId ? patch(doc) : doc)),
    })),
  };
}

/** Optimistic: an in-flight placeholder card appears immediately; on success the caller
 * navigates to the new document (the list itself is invalidated in the background so it's
 * accurate whenever the user comes back to it). On failure, rolls back and toasts.
 *
 * `onCreated` (if given) is wired into the mutation's OWN `onSuccess`, not a callback passed
 * to `.mutate()` — the optimistic update above inserts the placeholder card into the list,
 * which for the empty-state CTA immediately unmounts the calling component (EmptyState swaps
 * for the real grid the instant the list goes from 0 to 1 items). React Query drops callbacks
 * passed to `.mutate(vars, { onSuccess })` if the mutating component unmounts before the
 * network request resolves, but callbacks baked into `useMutation({ onSuccess })` itself are
 * bound to the mutation cache entry and always fire — so navigation MUST live here, not in the
 * caller's `.mutate()` call, or "create from the empty state" silently never navigates. */
export function useCreateDocument(options?: { onCreated?: (document: Document) => void }) {
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
    onSuccess: ({ document }) => {
      void queryClient.invalidateQueries({ queryKey: DOCUMENTS_LIST_QUERY_KEY });
      options?.onCreated?.(document);
    },
  });
}

const DEFAULT_DOCUMENT_TITLE = "Untitled document";

/** Shared by the "+ New document" tile and the empty-state CTA — create with a default title,
 * then navigate to the editor on success. */
export function useCreateDocumentAndNavigate() {
  const router = useRouter();
  const createDocument = useCreateDocument({
    onCreated: (document) => router.push(`/documents/${document.id}`),
  });

  return {
    create: () => createDocument.mutate({ title: DEFAULT_DOCUMENT_TITLE }),
    isPending: createDocument.isPending,
  };
}

interface PatchDocumentContext {
  previousList: DocumentsPages | undefined;
  previousDetail: GetDocumentResponse | undefined;
}

/** Rename and/or toggle-public. Used by the card's inline title editor (debounced by the
 * caller) and the editor header's title field. Optimistic: both the dashboard list cache and
 * this document's detail cache are patched immediately; a failure rolls both back and toasts. */
export function usePatchDocument(documentId: string) {
  const queryClient = useQueryClient();
  const detailKey = documentDetailQueryKey(documentId);

  return useMutation<{ document: Document }, unknown, PatchDocumentBody, PatchDocumentContext>({
    mutationFn: (body: PatchDocumentBody) =>
      apiClient.patch(`/api/v1/documents/${documentId}`, {
        body,
        responseSchema: patchDocumentResponseSchema,
      }),
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: DOCUMENTS_LIST_QUERY_KEY });
      await queryClient.cancelQueries({ queryKey: detailKey });

      const previousList = queryClient.getQueryData<DocumentsPages>(DOCUMENTS_LIST_QUERY_KEY);
      const previousDetail = queryClient.getQueryData<GetDocumentResponse>(detailKey);

      queryClient.setQueryData<DocumentsPages>(DOCUMENTS_LIST_QUERY_KEY, (old) =>
        withDocumentPatched(old, documentId, (doc) => ({ ...doc, ...body })),
      );
      queryClient.setQueryData<GetDocumentResponse>(detailKey, (old) =>
        old ? { ...old, document: { ...old.document, ...body } } : old,
      );

      return { previousList, previousDetail };
    },
    onError: (_err, _body, context) => {
      if (context?.previousList) {
        queryClient.setQueryData(DOCUMENTS_LIST_QUERY_KEY, context.previousList);
      }
      if (context?.previousDetail) {
        queryClient.setQueryData(detailKey, context.previousDetail);
      }
      toast.error("Couldn't save that change. Please try again.");
    },
    onSuccess: ({ document }) => {
      queryClient.setQueryData<DocumentsPages>(DOCUMENTS_LIST_QUERY_KEY, (old) =>
        withDocumentPatched(old, documentId, (doc) => ({ ...doc, ...document })),
      );
      queryClient.setQueryData<GetDocumentResponse>(detailKey, (old) =>
        old ? { ...old, document } : old,
      );
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
