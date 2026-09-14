/**
 * The LEDGER_BASIC_AUTH check, shared by src/proxy.ts, the server-side data
 * access in data.ts, and the review Server Action.
 *
 * Next.js 16 says Proxy is for optimistic checks and "should not be used as a
 * full session management or authorization solution", and that Server Actions
 * need the same checks as public API endpoints
 * (node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md and
 * 02-guides/authentication.md). So the gate runs again next to the gateway key.
 */

/** True when no password is configured, or the Authorization header carries it. */
export function basicAuthOk(authorization: string | null | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  const header = authorization ?? "";
  return header.startsWith("Basic ") && timingSafeEqual(decodeBase64(header.slice(6)), expected);
}

/** atob throws on malformed input, which would turn a bad header into a 500 instead of a 401. */
function decodeBase64(value: string): string {
  try {
    return atob(value.trim());
  } catch {
    return "";
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
