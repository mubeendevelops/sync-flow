"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  authResponseSchema,
  type LoginBody,
  type PublicUser,
  type SignupBody,
} from "@sync-flow/schemas";
import { apiClient } from "@/lib/api-client";
import { useAuthStore } from "@/stores/auth-store";

export const AUTH_ME_QUERY_KEY = ["auth", "me"] as const;

async function fetchMe(): Promise<PublicUser | null> {
  try {
    const { user } = await apiClient.get("/api/v1/auth/me", { responseSchema: authResponseSchema });
    return user;
  } catch (err) {
    // Not logged in is a normal outcome of this particular call, not a query error.
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/**
 * Single interface for auth everywhere in apps/web. `user`/`isLoading` come from GET /auth/me
 * (React Query is the source of truth per CLAUDE.md); the Zustand auth store is kept in sync
 * alongside it for code that needs synchronous access outside of a query (see stores/auth-store.ts).
 */
export function useAuth() {
  const queryClient = useQueryClient();
  const setUser = useAuthStore((s) => s.setUser);
  const clearUser = useAuthStore((s) => s.clear);

  const meQuery = useQuery({
    queryKey: AUTH_ME_QUERY_KEY,
    queryFn: async () => {
      const user = await fetchMe();
      if (user) setUser(user);
      else clearUser();
      return user;
    },
    retry: false,
  });

  const loginMutation = useMutation({
    mutationFn: (body: LoginBody) =>
      apiClient.post("/api/v1/auth/login", { body, responseSchema: authResponseSchema }),
    onSuccess: ({ user }) => {
      setUser(user);
      queryClient.setQueryData(AUTH_ME_QUERY_KEY, user);
    },
  });

  const signupMutation = useMutation({
    mutationFn: (body: SignupBody) =>
      apiClient.post("/api/v1/auth/signup", { body, responseSchema: authResponseSchema }),
    onSuccess: ({ user }) => {
      setUser(user);
      queryClient.setQueryData(AUTH_ME_QUERY_KEY, user);
    },
  });

  const logoutMutation = useMutation({
    mutationFn: () => apiClient.post("/api/v1/auth/logout"),
    onSuccess: () => {
      clearUser();
      queryClient.setQueryData(AUTH_ME_QUERY_KEY, null);
    },
  });

  return {
    user: meQuery.data ?? null,
    isLoading: meQuery.isLoading,
    login: loginMutation.mutateAsync,
    signup: signupMutation.mutateAsync,
    logout: logoutMutation.mutateAsync,
  };
}

/**
 * The client-side half of the route guard: middleware.ts only checks that the auth cookie
 * exists (it can't verify the JWT without shipping the signing secret to the edge), so a stale
 * or expired-but-present cookie still reaches the page. This catches that case once /auth/me
 * actually resolves and bounces to /login — the counterpart to the interceptor in
 * lib/api-client.ts, which only fires for a session that goes bad *after* this initial check.
 */
export function useRequireAuth() {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!auth.isLoading && !auth.user) {
      router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
    }
  }, [auth.isLoading, auth.user, pathname, router]);

  return auth;
}
