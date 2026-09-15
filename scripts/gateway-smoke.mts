/**
 * pnpm gateway:smoke
 *
 * Proves the automatic loop against a running gateway, without a provider key
 * or a Claude Code session. It does what the hooks and Claude Code do:
 *   1. creates a temporary virtual key (the admin key in .env.local)
 *   2. reports two sessions to the registry, on tickets SMOKE-1 and SMOKE-2,
 *      with that key's fingerprint
 *   3. calls the priced mock model with only `x-claude-code-session-id`
 *   4. waits for LiteLLM to write spend and reads it back per ticket
 * Then it deletes the temporary key.
 */
import { randomUUID } from "node:crypto";
import { loadContract } from "../src/lib/contract.ts";
import { loadEnvLocal } from "../src/lib/env.ts";
import { formatTokens, formatUsd } from "../src/lib/format.ts";
import { summarizeTickets } from "../src/lib/ledger.ts";
import { fetchTagActivity, lastDays } from "../src/lib/litellm.ts";
import { keyFingerprint, reportSession } from "../src/lib/registry-client.ts";
import { requestsByKey, smokeLanded } from "../src/lib/smoke.ts";

loadEnvLocal([process.cwd()]);
const baseUrl = process.env.LITELLM_BASE_URL || "http://localhost:4000";
const registryUrl = process.env.TPT_REGISTRY_URL || "http://localhost:4100";
const adminKey = process.env.LITELLM_API_KEY;
if (!adminKey) {
  console.error("✖ Set LITELLM_API_KEY in .env.local (see .env.example).");
  process.exit(1);
}

const loaded = loadContract();
// SMOKE-* keys must parse even when the team narrows key.teams to [ENG, ...].
const contract = { ...loaded, key: { ...loaded.key, teams: [] } };
const calls: Record<string, number> = { "SMOKE-1": 3, "SMOKE-2": 1 };
const tickets = Object.keys(calls);
const range = lastDays(1);

async function admin(path: string, body: unknown) {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<Record<string, unknown>>;
}

async function smokeRequests() {
  const rows = summarizeTickets(await fetchTagActivity(range, { baseUrl, apiKey: adminKey! }), contract).filter((row) =>
    tickets.includes(row.key),
  );
  return { rows, counts: requestsByKey(rows, tickets) };
}

function fail(message: string): never {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

let temporaryKey: string | undefined;
try {
  // Earlier runs already left SMOKE-* spend today. Only count what this run adds.
  const baseline = (await smokeRequests()).counts;

  temporaryKey = String((await admin("/key/generate", { key_alias: `tpt-smoke-${Date.now().toString(36)}`, duration: "1h" })).key);
  console.log(`1. Created a temporary virtual key`);

  for (const [ticket, count] of Object.entries(calls)) {
    const sessionId = randomUUID();
    const reported = await reportSession(
      { session_id: sessionId, key_fingerprint: keyFingerprint(temporaryKey), ticket, branch: `smoke/${ticket.toLowerCase()}`, repo: "smoke", head: null, event: "SessionStart" },
      { registryUrl, timeoutMs: 5_000 },
    );
    if (!reported.ok) fail(`The registry refused the session: ${reported.reason}. Is it running (pnpm gateway:up)?`);
    console.log(`2. Reported session ${sessionId.slice(0, 8)} on ${ticket}`);

    for (let i = 0; i < count; i++) {
      // The mock model is only priced on the OpenAI-format endpoint.
      const response = await fetch(new URL("/v1/chat/completions", baseUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${temporaryKey}`, "Content-Type": "application/json", "x-claude-code-session-id": sessionId },
        body: JSON.stringify({ model: "mock-ticket-model", messages: [{ role: "user", content: `smoke call ${i + 1} for ${ticket}` }] }),
      });
      if (!response.ok) fail(`${response.status} from the gateway: ${await response.text()}`);
    }
    console.log(`3. Sent ${count} ${count === 1 ? "call" : "calls"} with only the session id`);
  }

  const started = Date.now();
  process.stdout.write("4. Waiting for LiteLLM to write spend");
  while (Date.now() - started < 120_000) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    process.stdout.write(".");
    const { rows, counts } = await smokeRequests();
    if (smokeLanded(baseline, counts, calls)) {
      console.log("\n");
      for (const row of rows) {
        console.log(
          `   ${row.key.padEnd(8)} ${formatUsd(row.spend).padStart(8)}  ${formatTokens(row.totalTokens).padStart(6)} tokens  ${row.requests} ${row.requests === 1 ? "request" : "requests"} today`,
        );
      }
      console.log("\n✓ The gateway attributed each session's calls to its ticket. Try: pnpm ticket:report SMOKE-1\n");
      process.exitCode = 0;
      break;
    }
  }
  if (process.exitCode !== 0) {
    fail(
      "Spend didn't land on the tickets within 2 minutes. Check that the plugin is loaded: docker compose -f gateway/docker-compose.yml logs litellm",
    );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  if (temporaryKey) await admin("/key/delete", { keys: [temporaryKey] }).catch(() => undefined);
}
