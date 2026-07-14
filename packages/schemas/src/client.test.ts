import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";

/** Minimal fetch Response stand-in — avoids depending on a DOM/undici Response implementation. */
function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: () => Promise.resolve(body),
  } as Response;
}

describe("createApiClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses a successful response against the given schema", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createApiClient({ baseUrl: "http://localhost:4000" });
    const result = await client.get("/api/v1/health", {
      responseSchema: z.object({ ok: z.boolean() }),
    });

    expect(result).toEqual({ ok: true });
  });

  it("throws ApiError with the RFC 7807 fields on a non-2xx response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse(401, {
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        detail: "Invalid credentials",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createApiClient({ baseUrl: "http://localhost:4000" });
    await expect(client.get("/api/v1/auth/me")).rejects.toThrow(ApiError);
    await expect(client.get("/api/v1/auth/me")).rejects.toMatchObject({
      status: 401,
      detail: "Invalid credentials",
    });
  });

  it("echoes the CSRF cookie as a request header on unsafe methods only", async () => {
    vi.stubGlobal("document", { cookie: "csrf_token=abc123" });
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(204, null));
    vi.stubGlobal("fetch", fetchMock);

    const client = createApiClient({ baseUrl: "http://localhost:4000" });

    await client.get("/api/v1/documents");
    const getHeaders = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(getHeaders["x-csrf-token"]).toBeUndefined();

    await client.post("/api/v1/documents", { body: { title: "Untitled" } });
    const postHeaders = fetchMock.mock.calls[1]![1].headers as Record<string, string>;
    expect(postHeaders["x-csrf-token"]).toBe("abc123");
  });
});
