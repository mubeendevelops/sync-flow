import type { z } from "zod";
import { normalizeErrorResponse } from "./errors.js";

/**
 * Double-submit CSRF cookie/header names. Must match apps/server/src/auth/cookies.ts
 * (CSRF_TOKEN_COOKIE) and apps/server/src/middleware/csrf.ts (CSRF_HEADER) — the cookie is
 * intentionally not httpOnly so client JS can read and echo it.
 */
const CSRF_TOKEN_COOKIE = "csrf_token";
const CSRF_HEADER = "x-csrf-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface ApiClientConfig {
  /** e.g. NEXT_PUBLIC_API_URL, no trailing slash. */
  baseUrl: string;
}

export interface ApiRequestOptions<TResponse> {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Parses and validates the response body. Omit for endpoints that return 204 No Content. */
  responseSchema?: z.ZodType<TResponse>;
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: ApiRequestOptions<unknown>["query"],
): string {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Thin typed fetch wrapper shared by every apps/web API call. Always sends cookies
 * (credentials: "include" — auth is httpOnly-cookie based, see CLAUDE.md), always echoes the
 * CSRF double-submit header on state-changing methods, and normalizes non-2xx responses to
 * ApiError via the RFC 7807 problem+json body the backend returns.
 */
export function createApiClient(config: ApiClientConfig) {
  async function request<TResponse>(
    path: string,
    options: ApiRequestOptions<TResponse> = {},
  ): Promise<TResponse> {
    const method = options.method ?? "GET";
    const headers: Record<string, string> = {};

    if (!SAFE_METHODS.has(method)) {
      const csrfToken = readCookie(CSRF_TOKEN_COOKIE);
      if (csrfToken) headers[CSRF_HEADER] = csrfToken;
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const response = await fetch(buildUrl(config.baseUrl, path, options.query), {
      method,
      headers,
      body,
      credentials: "include",
    });

    if (!response.ok) {
      throw await normalizeErrorResponse(response);
    }

    if (!options.responseSchema || response.status === 204) {
      return undefined as TResponse;
    }

    const json: unknown = await response.json();
    return options.responseSchema.parse(json);
  }

  return {
    get: <TResponse>(
      path: string,
      options?: Omit<ApiRequestOptions<TResponse>, "method" | "body">,
    ) => request<TResponse>(path, { ...options, method: "GET" }),
    post: <TResponse>(path: string, options?: Omit<ApiRequestOptions<TResponse>, "method">) =>
      request<TResponse>(path, { ...options, method: "POST" }),
    patch: <TResponse>(path: string, options?: Omit<ApiRequestOptions<TResponse>, "method">) =>
      request<TResponse>(path, { ...options, method: "PATCH" }),
    delete: <TResponse>(
      path: string,
      options?: Omit<ApiRequestOptions<TResponse>, "method" | "body">,
    ) => request<TResponse>(path, { ...options, method: "DELETE" }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
