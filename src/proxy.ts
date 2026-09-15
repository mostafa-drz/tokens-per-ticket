import { NextResponse, type NextRequest } from "next/server";
import { basicAuthOk } from "./lib/basic-auth";

/**
 * Optional password gate. When LEDGER_BASIC_AUTH=user:password is set, every
 * page and server action asks for it. Required before deploying with
 * LEDGER_DATA=litellm, since the ledger shows organization-wide spend.
 *
 * This is the first line only: data.ts checks the same
 * header again before they use the gateway key (src/lib/basic-auth.ts).
 *
 * Basic auth is deliberately small. Put the app behind your SSO (for example
 * Vercel Deployment Protection) for anything beyond a team demo.
 */
export function proxy(request: NextRequest) {
  if (basicAuthOk(request.headers.get("authorization"), process.env.LEDGER_BASIC_AUTH)) {
    return NextResponse.next();
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="tokens-per-ticket", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
