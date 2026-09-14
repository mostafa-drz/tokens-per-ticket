/**
 * pnpm ticket:report [TICKET-KEY] [--days 30] [--post]
 *
 * Prints what a ticket has cost so far, straight from LiteLLM.
 * With --post, writes the same report as one comment on the Linear ticket,
 * updated in place on later runs.
 *
 * Without a key, reads it from the current branch.
 */
import { parseArgs } from "node:util";
import { findTicketKey, loadContract, normalizeTicketKey, ticketTag } from "../src/lib/contract.ts";
import { loadEnvLocal } from "../src/lib/env.ts";
import { currentBranch, mainCheckoutRoot, tryGit } from "../src/lib/git.ts";
import { summarizeTicket } from "../src/lib/ledger.ts";
import { postUnsupportedReason, upsertReportComment } from "../src/lib/linear.ts";
import { fetchTagActivity, lastDays } from "../src/lib/litellm.ts";
import { renderReport } from "../src/lib/report.ts";

const USAGE = `Usage: pnpm ticket:report [TICKET-KEY] [--days <n>] [--post]

  --days <n>   Look back this many days, today included (default 30)
  --post       Create or update the report comment on the Linear ticket

Environment (.env.local here or in the main checkout): LITELLM_BASE_URL, LITELLM_API_KEY, LINEAR_API_KEY (for --post)`;

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    days: { type: "string", default: "30" },
    post: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const mainRoot = mainCheckoutRoot();
// Ticket worktrees have no .env.local of their own (it's gitignored).
loadEnvLocal([tryGit(["rev-parse", "--show-toplevel"]) ?? process.cwd(), mainRoot]);
const contract = loadContract(mainRoot);
const branch = currentBranch();
const key = positionals[0]
  ? (normalizeTicketKey(positionals[0], contract) ?? fail(`"${positionals[0]}" is not a ticket key.`))
  : ((branch && findTicketKey(branch, contract)) ??
    fail(`Branch "${branch ?? "(detached)"}" doesn't name a ticket. Pass a key: pnpm ticket:report ENG-123`));

if (values.post) {
  const reason = postUnsupportedReason(contract.tracker);
  if (reason) fail(reason);
}

const days = Number.parseInt(values.days, 10);
if (!Number.isInteger(days) || days < 1) fail("--days must be a positive whole number.");

const apiKey = process.env.LITELLM_API_KEY || fail("Set LITELLM_API_KEY in .env.local (see .env.example).");
const baseUrl = process.env.LITELLM_BASE_URL || "http://localhost:4000";

const tag = ticketTag(key, contract);
const range = lastDays(days);

try {
  const detail = summarizeTicket(key, await fetchTagActivity({ tags: [tag], ...range }, { baseUrl, apiKey }));

  if (!detail) {
    console.log(
      `\nNo spend recorded for ${key} (tag ${tag}) between ${range.startDate} and ${range.endDate}.\n` +
        "If you worked on it, check that Claude Code was started with `pnpm ticket:start` and points at the gateway.\n" +
        "LiteLLM also writes spend in batches, so calls from the last minute may not show yet.\n",
    );
    process.exit(0);
  }

  const report = renderReport({ detail, tag, range, generatedAt: new Date() });
  console.log(`\n${report}\n`);

  if (values.post) {
    const linearKey = process.env.LINEAR_API_KEY || fail("Set LINEAR_API_KEY in .env.local to use --post.");
    const { issue, action } = await upsertReportComment({ key, body: report }, { apiKey: linearKey });
    console.log(`✓ Report comment ${action} on ${issue.identifier}: ${issue.url}`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
