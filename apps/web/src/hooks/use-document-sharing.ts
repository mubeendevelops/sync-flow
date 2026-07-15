"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ApiError,
  getDocumentResponseSchema,
  transferOwnerResponseSchema,
  type DocumentRole,
  type GetDocumentResponse,
  type Member,
  type PublicUser,
} from "@sync-flow/schemas";
import { apiClient } from "@/lib/api-client";
import {
  DOCUMENTS_LIST_QUERY_KEY,
  documentDetailQueryKey,
  withDocumentPatched,
  type DocumentsPages,
} from "@/hooks/use-documents";

export { documentDetailQueryKey };

export function useDocumentDetail(documentId: string, enabled = true) {
  return useQuery({
    queryKey: documentDetailQueryKey(documentId),
    queryFn: () =>
      apiClient.get(`/api/v1/documents/${documentId}`, {
        responseSchema: getDocumentResponseSchema,
      }),
    enabled,
  });
}

/** Every share-dialog mutation also invalidates the dashboard list in the background (role badge
 * + avatar stack) — the optimistic patch below keeps that cache correct instantly; the
 * invalidation just guards against drift from data this client can't see (e.g. another tab). */
function useInvalidateSharing(documentId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: documentDetailQueryKey(documentId) });
    void queryClient.invalidateQueries({ queryKey: DOCUMENTS_LIST_QUERY_KEY });
  };
}

interface SharingContext {
  previousDetail: GetDocumentResponse | undefined;
  previousList: DocumentsPages | undefined;
}

function snapshotSharing(
  queryClient: ReturnType<typeof useQueryClient>,
  documentId: string,
): SharingContext {
  return {
    previousDetail: queryClient.getQueryData<GetDocumentResponse>(
      documentDetailQueryKey(documentId),
    ),
    previousList: queryClient.getQueryData<DocumentsPages>(DOCUMENTS_LIST_QUERY_KEY),
  };
}

function rollbackSharing(
  queryClient: ReturnType<typeof useQueryClient>,
  documentId: string,
  context: SharingContext | undefined,
): void {
  if (context?.previousDetail) {
    queryClient.setQueryData(documentDetailQueryKey(documentId), context.previousDetail);
  }
  if (context?.previousList) {
    queryClient.setQueryData(DOCUMENTS_LIST_QUERY_KEY, context.previousList);
  }
}

export interface InviteMemberVariables {
  user: PublicUser;
  role: DocumentRole;
}

/** Optimistic: the invited user appears in the member list (and the dashboard card's avatar
 * stack) immediately, using the info already in hand from the search result. Rolled back with a
 * toast if the server rejects the invite (e.g. already a member, role validation). */
export function useInviteMember(documentId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateSharing(documentId);
  const detailKey = documentDetailQueryKey(documentId);

  return useMutation<unknown, unknown, InviteMemberVariables, SharingContext>({
    mutationFn: ({ user, role }) =>
      apiClient.post(`/api/v1/documents/${documentId}/invite`, {
        body: { email: user.email, role },
      }),
    onMutate: async ({ user, role }) => {
      await queryClient.cancelQueries({ queryKey: detailKey });
      await queryClient.cancelQueries({ queryKey: DOCUMENTS_LIST_QUERY_KEY });
      const context = snapshotSharing(queryClient, documentId);

      const optimisticMember: Member = {
        userId: user.id,
        role,
        username: user.username,
        displayName: user.displayName,
        presenceColor: user.presenceColor,
        joinedAt: new Date().toISOString(),
      };

      queryClient.setQueryData<GetDocumentResponse>(detailKey, (old) =>
        old ? { ...old, members: [...old.members, optimisticMember] } : old,
      );
      queryClient.setQueryData<DocumentsPages>(DOCUMENTS_LIST_QUERY_KEY, (old) =>
        withDocumentPatched(old, documentId, (doc) => ({
          ...doc,
          collaborators: [
            ...doc.collaborators,
            {
              userId: user.id,
              username: user.username,
              displayName: user.displayName,
              presenceColor: user.presenceColor,
              role,
            },
          ],
        })),
      );

      return context;
    },
    onSuccess: invalidate,
    onError: (err, _vars, context) => {
      rollbackSharing(queryClient, documentId, context);
      toast.error(
        err instanceof ApiError ? (err.detail ?? err.title) : "Couldn't add that collaborator.",
      );
    },
  });
}

/** Optimistic: the removed member disappears from the list (and the dashboard avatar stack)
 * immediately; rolled back with a toast on failure. */
export function useRemoveMember(documentId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateSharing(documentId);
  const detailKey = documentDetailQueryKey(documentId);

  return useMutation<unknown, unknown, string, SharingContext>({
    mutationFn: (userId: string) =>
      apiClient.delete(`/api/v1/documents/${documentId}/members/${userId}`),
    onMutate: async (userId) => {
      await queryClient.cancelQueries({ queryKey: detailKey });
      await queryClient.cancelQueries({ queryKey: DOCUMENTS_LIST_QUERY_KEY });
      const context = snapshotSharing(queryClient, documentId);

      queryClient.setQueryData<GetDocumentResponse>(detailKey, (old) =>
        old ? { ...old, members: old.members.filter((m) => m.userId !== userId) } : old,
      );
      queryClient.setQueryData<DocumentsPages>(DOCUMENTS_LIST_QUERY_KEY, (old) =>
        withDocumentPatched(old, documentId, (doc) => ({
          ...doc,
          collaborators: doc.collaborators.filter((c) => c.userId !== userId),
        })),
      );

      return context;
    },
    onSuccess: invalidate,
    onError: (_err, _userId, context) => {
      rollbackSharing(queryClient, documentId, context);
      toast.error("Couldn't remove that collaborator. Please try again.");
    },
  });
}

export function useTransferOwnership(documentId: string) {
  const invalidate = useInvalidateSharing(documentId);
  return useMutation({
    mutationFn: (userId: string) =>
      apiClient.post(`/api/v1/documents/${documentId}/transfer-owner`, {
        body: { userId },
        responseSchema: transferOwnerResponseSchema,
      }),
    onSuccess: invalidate,
    onError: () => {
      toast.error("Couldn't transfer ownership. Please try again.");
    },
  });
}
