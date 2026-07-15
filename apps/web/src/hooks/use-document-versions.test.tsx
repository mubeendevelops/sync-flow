import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiError } from "@sync-flow/schemas";
import { useRestoreVersion, useVersionPreview, useVersionsInfinite } from "./use-document-versions";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
  },
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

const DOC_ID = "11111111-1111-1111-1111-111111111111";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useVersionsInfinite", () => {
  beforeEach(() => {
    get.mockReset();
  });

  it("fetches the first page with no cursor and exposes nextCursor for pagination", async () => {
    get.mockResolvedValueOnce({
      versions: [{ version: 5, createdAt: "2026-07-01T00:00:00.000Z", kind: "auto" }],
      nextCursor: "5",
    });

    const { result } = renderHook(() => useVersionsInfinite(DOC_ID, true), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith(
      `/api/v1/documents/${DOC_ID}/versions`,
      expect.objectContaining({ query: { cursor: undefined, limit: 20 } }),
    );
    expect(result.current.hasNextPage).toBe(true);
  });

  it("does not fetch while disabled", () => {
    renderHook(() => useVersionsInfinite(DOC_ID, false), { wrapper });
    expect(get).not.toHaveBeenCalled();
  });
});

describe("useVersionPreview", () => {
  beforeEach(() => {
    get.mockReset();
  });

  it("fetches the reconstructed text for the given version", async () => {
    get.mockResolvedValueOnce({ version: 3, text: "Hello World", state: {} });

    const { result } = renderHook(() => useVersionPreview(DOC_ID, 3), { wrapper });

    await waitFor(() => expect(result.current.data?.text).toBe("Hello World"));
    expect(get).toHaveBeenCalledWith(
      `/api/v1/documents/${DOC_ID}/versions/3`,
      expect.anything(),
    );
  });

  it("stays disabled when no version is selected", () => {
    renderHook(() => useVersionPreview(DOC_ID, null), { wrapper });
    expect(get).not.toHaveBeenCalled();
  });
});

describe("useRestoreVersion", () => {
  beforeEach(() => {
    post.mockReset();
    toastError.mockClear();
  });

  it("posts to the restore endpoint for the given version", async () => {
    post.mockResolvedValueOnce({
      restore: {
        restoredToVersion: 2,
        restorePointVersion: 5,
        newVersion: 6,
        opCount: 3,
        text: "Hello",
      },
    });

    const { result } = renderHook(() => useRestoreVersion(DOC_ID), { wrapper });
    await result.current.mutateAsync(2);

    expect(post).toHaveBeenCalledWith(
      `/api/v1/documents/${DOC_ID}/restore/2`,
      expect.anything(),
    );
  });

  it("toasts the server-provided detail on failure", async () => {
    post.mockRejectedValueOnce(
      new ApiError({
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail: "Only the owner can restore",
      }),
    );

    const { result } = renderHook(() => useRestoreVersion(DOC_ID), { wrapper });
    await expect(result.current.mutateAsync(2)).rejects.toThrow();

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Only the owner can restore"));
  });
});
