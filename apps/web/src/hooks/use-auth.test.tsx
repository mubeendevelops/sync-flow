import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiError } from "@sync-flow/schemas";
import { useAuth } from "./use-auth";
import { useAuthStore } from "@/stores/auth-store";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
  },
}));

const testUser = {
  id: "11111111-1111-1111-1111-111111111111",
  username: "ada",
  email: "ada@example.com",
  displayName: "Ada Lovelace",
  presenceColor: "#4f46e5",
};

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useAuth", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    useAuthStore.setState({ user: null });
  });

  it("resolves user: null when /auth/me 401s (not logged in)", async () => {
    get.mockRejectedValueOnce(
      new ApiError({ type: "about:blank", title: "Unauthorized", status: 401 }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.user).toBeNull();
  });

  it("resolves the logged-in user from /auth/me and mirrors it into the auth store", async () => {
    get.mockResolvedValueOnce({ user: testUser });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.user).toEqual(testUser));
    expect(useAuthStore.getState().user).toEqual(testUser);
  });

  it("login() sets the user on success", async () => {
    get.mockRejectedValueOnce(
      new ApiError({ type: "about:blank", title: "Unauthorized", status: 401 }),
    );
    post.mockResolvedValueOnce({ user: testUser });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await result.current.login({ email: testUser.email, password: "correct-password" });

    await waitFor(() => expect(result.current.user).toEqual(testUser));
  });

  it("logout() clears the user", async () => {
    get.mockResolvedValueOnce({ user: testUser });
    post.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).toEqual(testUser));

    await result.current.logout();

    await waitFor(() => expect(result.current.user).toBeNull());
    expect(useAuthStore.getState().user).toBeNull();
  });
});
