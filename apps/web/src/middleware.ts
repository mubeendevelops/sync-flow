import { NextResponse, type NextRequest } from "next/server";

// Must match apps/server/src/auth/cookies.ts's ACCESS_TOKEN_COOKIE. This is a presence-only
// check — the edge runtime can't verify the JWT without shipping JWT_ACCESS_SECRET to the
// client bundle, so a stale/expired-but-present cookie still passes here. useRequireAuth
// (apps/web/src/hooks/use-auth.ts) catches that case once GET /auth/me actually resolves.
const ACCESS_TOKEN_COOKIE = "access_token";

const PUBLIC_PATHS = new Set(["/", "/login", "/register"]);

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  const hasSession = request.cookies.has(ACCESS_TOKEN_COOKIE);
  if (!hasSession) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname + search);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.\\w+$).*)"],
};
