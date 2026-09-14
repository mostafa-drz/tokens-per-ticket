import { NextResponse, type NextRequest } from "next/server";

/**
 * Optional password gate. When LEDGER_BASIC_AUTH=user:password is set, every
 * page and server action asks for it. Required before deploying with
 * LEDGER_DATA=litellm, since the ledger shows organization-wide spend.
 *
 * Basic auth is deliberately small. Put the app behind your SSO (for example
 * Vercel Deployment Protection) for anything beyond a team demo.
 */
export function proxy(request: NextRequest) {
  const expected = process.env.LEDGER_BASIC_AUTH;
  if (!expected) return NextResponse.next();

  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ") && timingSafeEqual(atob(header.slice(6)), expected)) {
    return NextResponse.next();
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="tokens-per-ticket", charset="UTF-8"' },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
