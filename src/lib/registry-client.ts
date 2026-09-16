/**
 * Reports a Claude Code session's ticket to the session registry
 * (registry/src/server.mjs). Called from the hooks, so it must be quick and
 * must never throw: a slow or down registry only means untagged spend.
 *
 * It authenticates with the developer's LiteLLM virtual key. The URL comes
 * from TPT_REGISTRY_URL or the repo's tokens-per-ticket.yaml; both are as
 * trusted as the repo's .claude/settings.json, which can set either.
 */

export type SessionReport = {
  session_id: string;
  ticket: string | null;
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
