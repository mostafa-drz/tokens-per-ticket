/**
 * pnpm gateway:smoke
 *
 * Proves the automatic loop against a running gateway, without a provider key
 * or a Claude Code session. It does what the hooks and Claude Code do:
 *   1. creates a temporary virtual key (with the admin key in .env.local)
 *   2. reports two sessions to the registry, on tickets SMOKE-1 and SMOKE-2
 *   3. calls the priced mock model with only `x-claude-code-session-id`
 *   4. waits for LiteLLM to write spend and reads it back per ticket
 * Then it deletes the temporary key.
 */
import { randomUUID } from "node:crypto";
import { loadEnvLocal } from "../src/lib/env.ts";
import { reportSession } from "../src/lib/registry-client.ts";

loadEnvLocal([process.cwd()]);
const baseUrl = process.env.LITELLM_BASE_URL || "http://localhost:4000";
const registryUrl = process.env.TPT_REGISTRY_URL || "http://localhost:4100";
const adminKey = process.env.LITELLM_API_KEY;
if (!adminKey) {
  console.error("✖ Set LITELLM_API_KEY in .env.local (see .env.example).");
  process.exit(1);
}

const calls: Record<string, number> = { "SMOKE-1": 3, "SMOKE-2": 1 };
const today = new Date().toISOString().slice(0, 10);

function fail(message: string): never {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

async function admin(path: string, body: unknown) {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<Record<string, unknown>>;
}

/** Requests recorded today for each ticket tag, straight from LiteLLM. */
async function requests(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const ticket of Object.keys(calls)) {
    const url = new URL("/tag/daily/activity", baseUrl);
    url.search = new URLSearchParams({ tags: `ticket:${ticket}`, start_date: today, end_date: today, page_size: "1000" }).toString();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${adminKey}` }  });
    if (!response.ok) fail(`${response.status} from /tag/daily/activity. Is LITELLM_API_KEY an admin or viewer key?`);
    const body = (await response.json()) as { results?: { metrics?: { api_requests?: number } }[] };
    counts[ticket] = (body.results ?? []).reduce((total, day) => total + (day.metrics?.api_requests ?? 0), 0);
  }
  return counts;
}

let temporaryKey: string | undefined;
try {
  // A gateway started without its master key accepts admin calls from anyone.
  const unauthenticated = await fetch(new URL("/key/info", baseUrl), { headers: { Authorization: "Bearer sk-not-a-real-key" } });
  if (unauthenticated.ok) fail("The gateway accepted a made-up key for an admin route. LITELLM_MASTER_KEY isn't reaching LiteLLM; check gateway/.env.");

  // Earlier runs already left SMOKE-* spend today. Only count what this run adds.
  const before = await requests();

  temporaryKey = String((await admin("/key/generate", { key_alias: `tpt-smoke-${Date.now().toString(36)}`, duration: "1h" })).key);
  console.log("1. Created a temporary virtual key");

  for (const [ticket, count] of Object.entries(calls)) {
    const sessionId = randomUUID();
    const reported = await reportSession(
      { session_id: sessionId, ticket, event: "SessionStart" },
      { registryUrl, gatewayKey: temporaryKey, timeoutMs: 5_000 },
    );
    if (!reported.ok) fail(`The registry refused the session: ${reported.reason}. Is it running (pnpm gateway:up)?`);

    for (let i = 0; i < count; i++) {
      // The mock model is only priced on the OpenAI-format endpoint.
      const response = await fetch(new URL("/v1/chat/completions", baseUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${temporaryKey}`, "Content-Type": "application/json", "x-claude-code-session-id": sessionId },
        body: JSON.stringify({ model: "mock-ticket-model", messages: [{ role: "user", content: `smoke call ${i + 1} for ${ticket}` }] }),
      });
      if (!response.ok) fail(`${response.status} from the gateway: ${await response.text()}`);
    }
  }
  console.log("2. Reported a session on each of SMOKE-1 and SMOKE-2");
  console.log("3. Called the mock model with only the session id: 3 calls on SMOKE-1, 1 on SMOKE-2");

  const started = Date.now();
  process.stdout.write("4. Waiting for LiteLLM to write spend");
  while (Date.now() - started < 120_000) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    process.stdout.write(".");
    const now = await requests();
    const added = Object.fromEntries(Object.keys(calls).map((ticket) => [ticket, now[ticket] - (before[ticket] ?? 0)]));
    if (Object.entries(calls).every(([ticket, count]) => added[ticket] >= count)) {
      console.log("\n");
      for (const [ticket, count] of Object.entries(calls)) {
        console.log(`   ${ticket.padEnd(8)} +${added[ticket]} this run (${count} expected), ${now[ticket]} requests today`);
      }
      console.log("\n✓ The gateway attributed each session's calls to its ticket.\n");
      process.exit(0);
    }
  }
  fail("Spend didn't land on the tickets within 2 minutes. Check that the plugin is loaded: docker compose -f gateway/docker-compose.yml logs litellm");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  if (temporaryKey) await admin("/key/delete", { keys: [temporaryKey] }).catch(() => undefined);
}
