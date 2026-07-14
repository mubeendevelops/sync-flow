import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

function requestFor(path: string, cookie?: string) {
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    headers: cookie ? { cookie } : undefined,
  });
}

describe("middleware", () => {
  it("lets public paths through with no cookie", () => {
    for (const path of ["/", "/login", "/register"]) {
      const res = middleware(requestFor(path));
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("redirects a protected path with no session cookie to /login", () => {
    const res = middleware(requestFor("/documents"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("redirect")).toBe("/documents");
  });

  it("preserves the query string in the redirect target", () => {
    const res = middleware(requestFor("/documents/abc?tab=history"));
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("redirect")).toBe("/documents/abc?tab=history");
  });

  it("lets a protected path through when the access token cookie is present", () => {
    const res = middleware(requestFor("/documents", "access_token=some.jwt.value"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });
});
