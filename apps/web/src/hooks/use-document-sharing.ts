"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ApiError,
  getDocumentResponseSchema,
  transferOwnerResponseSchema,
  type InviteBody,
} from "@sync-flow/schemas";
import { apiClient } from "@/lib/api-client";
import { DOCUMENTS_LIST_QUERY_KEY } from "@/hooks/use-documents";

export function documentDetailQueryKey(documentId: string) {
  return ["documents", "detail", documentId] as const;
}

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

/** Every share-dialog mutation below invalidates both the document's own detail (member list,
 * owner) and the dashboard list (role badge + avatar stack) — cheap, infrequent actions where
 * correctness is worth more than avoiding a refetch. */
function useInvalidateSharing(documentId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: documentDetailQueryKey(documentId) });
    void queryClient.invalidateQueries({ queryKey: DOCUMENTS_LIST_QUERY_KEY });
  };
}

export function useInviteMember(documentId: string) {
  const invalidate = useInvalidateSharing(documentId);
  return useMutation({
    mutationFn: (body: InviteBody) =>
      apiClient.post(`/api/v1/documents/${documentId}/invite`, { body }),
    onSuccess: invalidate,
    onError: (err) => {
      toast.error(
        err instanceof ApiError ? (err.detail ?? err.title) : "Couldn't add that collaborator.",
      );
    },
  });
}

export function useRemoveMember(documentId: string) {
  const invalidate = useInvalidateSharing(documentId);
  return useMutation({
    mutationFn: (userId: string) =>
      apiClient.delete(`/api/v1/documents/${documentId}/members/${userId}`),
    onSuccess: invalidate,
    onError: () => {
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
