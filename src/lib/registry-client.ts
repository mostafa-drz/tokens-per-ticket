import { createHash } from "node:crypto";

/**
 * Reports a Claude Code session's ticket to the session registry
 * (registry/src/server.mjs). Called from the hooks, so it must be quick and
 * must never throw: a slow or down registry only means untagged spend.
 *
 * The gateway key never leaves the machine through this path. The report
 * carries keyFingerprint(key) instead, which the gateway plugin can compute
 * from the calling key's stored hash but nobody can turn back into a key.
 */

export type SessionReport = {
  session_id: string;
  key_fingerprint: string;
  ticket: string | null;
  branch: string | null;
  repo: string | null;
  head: string | null;
  event: string;
};

export type ReportResult = { ok: true } | { ok: false; reason: string };

export async function reportSession(
  report: SessionReport,
  config: { registryUrl: string; timeoutMs?: number; fetch?: typeof fetch },
): Promise<ReportResult> {
  try {
    const response = await (config.fetch ?? fetch)(new URL("/v1/sessions", config.registryUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(config.timeoutMs ?? 1500),
    });
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, reason: `registry answered ${response.status}${body?.error ? `: ${body.error}` : ""}` };
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : String(error);
    return { ok: false, reason: `could not reach the registry at ${config.registryUrl} (${reason})` };
  }
}

/**
 * sha256(sha256(key)), hex. LiteLLM keeps a virtual key as sha256(key)
 * (hash_token in litellm/proxy/_types.py) and rejects that hash as a
 * credential; one more round gives a value the gateway plugin can match
 * against `sha256(user_api_key_dict.token)` and that isn't stored anywhere.
 */
export function keyFingerprint(key: string): string {
  const once = createHash("sha256").update(key).digest("hex");
  return createHash("sha256").update(once).digest("hex");
}

/**
 * The registry URL to use, from trusted configuration only.
 *
 * TPT_REGISTRY_URL comes from the user's or the organization's Claude Code
 * settings. The repository's `automation.registry_url` is a default that any
 * branch can change, so it is honored only when it points at the same host as
 * ANTHROPIC_BASE_URL, which the user configured. Otherwise a branch could send
 * session details to a server of its choosing.
 */
export function trustedRegistryUrl(input: {
  envUrl?: string;
  repoUrl?: string;
  gatewayUrl?: string;
}): { url: string | null; ignored?: string } {
  if (input.envUrl) return { url: input.envUrl };
  if (!input.repoUrl) return { url: null };
  try {
    const repoHost = new URL(input.repoUrl).hostname;
    const gatewayHost = input.gatewayUrl ? new URL(input.gatewayUrl).hostname : null;
    if (gatewayHost && repoHost === gatewayHost) return { url: input.repoUrl };
  } catch {
    // Malformed URL: treat as untrusted.
  }
  return { url: null, ignored: input.repoUrl };
}
