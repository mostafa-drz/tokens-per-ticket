/**
 * pnpm gateway:smoke
 *
 * Proves the loop against a running gateway without any provider key or
 * Claude Code session: sends tagged calls to the priced mock model, waits for
 * LiteLLM to write them, then reads them back the same way the app does.
 */
import { loadContract, ticketTag } from "../src/lib/contract.ts";
import { loadEnvLocal } from "../src/lib/env.ts";
import { formatTokens, formatUsd } from "../src/lib/format.ts";
import { summarizeTickets } from "../src/lib/ledger.ts";
import { fetchTagActivity, lastDays } from "../src/lib/litellm.ts";

loadEnvLocal([process.cwd()]);
const baseUrl = process.env.LITELLM_BASE_URL || "http://localhost:4000";
const apiKey = process.env.LITELLM_API_KEY;
if (!apiKey) {
  console.error("✖ Set LITELLM_API_KEY in .env.local (see .env.example).");
  process.exit(1);
}

const contract = loadContract();
const calls: Record<string, number> = { "SMOKE-1": 3, "SMOKE-2": 1 };
const runId = Date.now().toString(36);

console.log(`Sending tagged calls to ${baseUrl} (run ${runId})…`);
for (const [key, count] of Object.entries(calls)) {
  for (let i = 0; i < count; i++) {
    // The mock model is only priced on the OpenAI-format endpoint.
    const response = await fetch(new URL("/v1/chat/completions", baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "x-litellm-tags": ticketTag(key, contract),
      },
      body: JSON.stringify({
        model: "mock-ticket-model",
        messages: [{ role: "user", content: `smoke ${runId} for ${key}, call ${i + 1}` }],
      }),
    });
    if (!response.ok) {
      console.error(`✖ ${response.status} from the gateway: ${await response.text()}`);
      process.exit(1);
    }
  }
}

const range = lastDays(1);
const before = Date.now();
process.stdout.write("Waiting for LiteLLM to write spend");
while (Date.now() - before < 120_000) {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  process.stdout.write(".");
  const rows = summarizeTickets(await fetchTagActivity(range, { baseUrl, apiKey }), contract).filter((row) =>
    row.key.startsWith("SMOKE-"),
  );
  if (rows.length === Object.keys(calls).length) {
    console.log("\n");
    for (const row of rows) {
      console.log(
        `  ${row.key.padEnd(8)} ${formatUsd(row.spend).padStart(8)}  ${formatTokens(row.totalTokens).padStart(6)} tokens  ${row.requests} ${row.requests === 1 ? "request" : "requests"} today`,
      );
    }
    console.log("\n✓ Tagged spend is flowing. Try: pnpm ticket:report SMOKE-1\n");
    process.exit(0);
  }
}

console.error("\n✖ Spend didn't show up within 2 minutes. Check `docker compose -f gateway/docker-compose.yml logs litellm`.");
process.exit(1);
