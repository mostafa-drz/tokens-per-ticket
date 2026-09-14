import { createHash } from "node:crypto";

/**
 * Checks a developer's gateway key with LiteLLM itself: GET /key/info called
 * with the key as its own credential returns the key's hashed token and alias
 * (checked against a v1.100.1 gateway). No admin key needed.
 *
 * Results are cached for a few minutes so hooks don't hit LiteLLM on every
 * prompt. A revoked key keeps working here for at most `ttlMs`.
 */
export function liteLLMKeyValidator({ baseUrl, ttlMs = 5 * 60_000, fetchImpl = fetch }) {
  const cache = new Map();

  return async function validateKey(key) {
    const id = createHash("sha256").update(key).digest("hex");
    const hit = cache.get(id);
    if (hit && hit.expires > Date.now()) return hit.identity;

    const response = await fetchImpl(new URL("/key/info", baseUrl), {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(3_000),
    });
    let identity = null;
    if (response.ok) {
      const body = await response.json();
      if (typeof body?.key === "string") identity = { token: body.key, alias: body.info?.key_alias ?? null };
    } else if (response.status >= 500) {
      throw new Error(`LiteLLM /key/info returned ${response.status}`);
    }
    cache.set(id, { identity, expires: Date.now() + (identity ? ttlMs : 30_000) });
    return identity;
  };
}
