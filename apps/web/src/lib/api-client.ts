import { ApiError, createApiClient, type ApiClient } from "@sync-flow/schemas";
import { useAuthStore } from "@/stores/auth-store";

const baseUrl = process.env.NEXT_PUBLIC_API_URL;
if (!baseUrl) {
  throw new Error("NEXT_PUBLIC_API_URL is not set");
}

const rawClient = createApiClient({ baseUrl });

// Auth pages call GET /auth/me themselves to check "am I logged in" — that 401 is expected for
// an anonymous visitor and must not bounce them straight back to /login.
const PUBLIC_PATHS = new Set(["/", "/login", "/register"]);

/**
 * A 401 only means "your session actually expired" if we thought we had one. An anonymous
 * visitor's own /auth/me check 401s too, and must not trigger this — useAuth's fetchMe already
 * translates that case to `user: null` without going through here as a failure.
 */
function handleUnauthorized(): void {
  if (typeof window === "undefined") return;
  if (useAuthStore.getState().user === null) return;

  useAuthStore.getState().clear();

  if (!PUBLIC_PATHS.has(window.location.pathname)) {
    const redirect = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?redirect=${redirect}`;
  }
}

async function withUnauthorizedInterceptor<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      handleUnauthorized();
    }
    throw err;
  }
}

/**
 * Single shared instance — every API call in apps/web goes through this. Wraps
 * @sync-flow/schemas's transport-only client with the app-specific 401 side effect (clear auth
 * state + redirect to /login), since that behavior needs the Zustand store and the browser
 * location, neither of which belong in the framework-agnostic shared package.
 */
export const apiClient: ApiClient = {
  get: (path, options) => withUnauthorizedInterceptor(rawClient.get(path, options)),
  post: (path, options) => withUnauthorizedInterceptor(rawClient.post(path, options)),
  patch: (path, options) => withUnauthorizedInterceptor(rawClient.patch(path, options)),
  delete: (path, options) => withUnauthorizedInterceptor(rawClient.delete(path, options)),
};
