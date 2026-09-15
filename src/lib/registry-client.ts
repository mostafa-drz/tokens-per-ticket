/**
 * Reports a Claude Code session's ticket to the session registry
 * (registry/src/server.mjs). Called from the hooks, so it must be quick and
 * must never throw: a slow or down registry only means untagged spend.
 *
 * It authenticates with the developer's LiteLLM virtual key. Only send it to a
 * URL from trustedRegistryUrl(): the user's own settings, or the gateway's
 * host, which receives that key on every model call anyway.
 */

export type SessionReport = {
  session_id: string;
  ticket: string | null;
  branch: string | null;
  repo: string | null;
  event: string;
};

export type ReportResult = { ok: true } | { ok: false; status?: number; reason: string };

export async function reportSession(
  report: SessionReport,
  config: { registryUrl: string; gatewayKey: string; timeoutMs?: number; fetch?: typeof fetch },
): Promise<ReportResult> {
  try {
    const response = await (config.fetch ?? fetch)(new URL("/v1/sessions", config.registryUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${config.gatewayKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(config.timeoutMs ?? 1500),
    });
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, status: response.status, reason: `registry answered ${response.status}${body?.error ? `: ${body.error}` : ""}` };
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : String(error);
    return { ok: false, reason: `could not reach the registry at ${config.registryUrl} (${reason})` };
  }
}

/**
 * The registry URL to use, from trusted configuration only, because the hook
 * sends the developer's gateway key there.
 *
 * TPT_REGISTRY_URL comes from the user's or the organization's Claude Code
 * settings. The repository's `automation.registry_url` is a default that any
 * branch can change, so it's honored only on the same host as
 * ANTHROPIC_BASE_URL, which the user configured and which already receives
 * the key.
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
