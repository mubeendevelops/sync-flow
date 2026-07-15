import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { GetDocumentResponse, PublicUser } from "@sync-flow/schemas";
import {
  documentDetailQueryKey,
  useInviteMember,
  useRemoveMember,
} from "./use-document-sharing";

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
    delete: (...args: unknown[]) => del(...args),
  },
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

const DOC_ID = "11111111-1111-1111-1111-111111111111";

const INVITED_USER: PublicUser = {
  id: "22222222-2222-2222-2222-222222222222",
  username: "newbie",
  email: "newbie@example.com",
  displayName: "New Bie",
  presenceColor: "#EB1700",
};

const EXISTING_MEMBER = {
  userId: "33333333-3333-3333-3333-333333333333",
  role: "editor" as const,
  username: "existing",
  displayName: "Existing Member",
  presenceColor: "#008A39",
  joinedAt: "2026-01-01T00:00:00.000Z",
};

const DETAIL: GetDocumentResponse = {
  document: {
    id: DOC_ID,
    title: "Doc",
    ownerId: "44444444-4444-4444-4444-444444444444",
    isPublic: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  owner: null,
  members: [EXISTING_MEMBER],
  version: 1,
};

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(documentDetailQueryKey(DOC_ID), DETAIL);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

describe("useInviteMember", () => {
  beforeEach(() => {
    post.mockReset();
    toastError.mockClear();
  });

  it("adds the invited user to the member list before the server responds", async () => {
    let resolvePost: (() => void) | undefined;
    post.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolvePost = () => resolve();
      }),
    );
    const { queryClient, wrapper } = makeWrapper();

    const { result } = renderHook(() => useInviteMember(DOC_ID), { wrapper });
    result.current.mutate({ user: INVITED_USER, role: "editor" });

    await waitFor(() => {
      const data = queryClient.getQueryData<GetDocumentResponse>(documentDetailQueryKey(DOC_ID));
      expect(data?.members.some((m) => m.userId === INVITED_USER.id)).toBe(true);
    });

    resolvePost?.();
  });

  it("rolls back and toasts when the invite is rejected", async () => {
    post.mockRejectedValueOnce(new Error("nope"));
    const { queryClient, wrapper } = makeWrapper();

    const { result } = renderHook(() => useInviteMember(DOC_ID), { wrapper });
    result.current.mutate({ user: INVITED_USER, role: "editor" });

    await waitFor(() => expect(toastError).toHaveBeenCalled());

    const data = queryClient.getQueryData<GetDocumentResponse>(documentDetailQueryKey(DOC_ID));
    expect(data?.members.some((m) => m.userId === INVITED_USER.id)).toBe(false);
    expect(data?.members).toEqual([EXISTING_MEMBER]);
  });
});

describe("useRemoveMember", () => {
  beforeEach(() => {
    del.mockReset();
    toastError.mockClear();
  });

  it("removes the member from the list before the server responds", async () => {
    let resolveDelete: (() => void) | undefined;
    del.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveDelete = () => resolve();
      }),
    );
    const { queryClient, wrapper } = makeWrapper();

    const { result } = renderHook(() => useRemoveMember(DOC_ID), { wrapper });
    result.current.mutate(EXISTING_MEMBER.userId);

    await waitFor(() => {
      const data = queryClient.getQueryData<GetDocumentResponse>(documentDetailQueryKey(DOC_ID));
      expect(data?.members).toEqual([]);
    });

    resolveDelete?.();
  });

  it("rolls back and toasts when removal fails", async () => {
    del.mockRejectedValueOnce(new Error("nope"));
    const { queryClient, wrapper } = makeWrapper();

    const { result } = renderHook(() => useRemoveMember(DOC_ID), { wrapper });
    result.current.mutate(EXISTING_MEMBER.userId);

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(
      "Couldn't remove that collaborator. Please try again.",
    ));

    const data = queryClient.getQueryData<GetDocumentResponse>(documentDetailQueryKey(DOC_ID));
    expect(data?.members).toEqual([EXISTING_MEMBER]);
  });
});
