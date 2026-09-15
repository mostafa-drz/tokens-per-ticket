/**
 * tpt report [TICKET-KEY] [--days 30] [--post]
 *
 * Prints what a ticket has cost so far, straight from LiteLLM.
 * With --post, writes the same report as one comment on the Linear or Jira ticket,
 * updated in place on later runs.
 *
 * Without a key, reads it from the current branch.
 */
import { parseArgs } from "node:util";
import { findTicketKey, loadContract, normalizeTicketKey, ticketTag } from "../lib/contract.ts";
import { loadEnvLocal } from "../lib/env.ts";
import { currentBranch, mainCheckoutRoot, tryGit } from "../lib/git.ts";
import { summarizeTicket } from "../lib/ledger.ts";
import { reportPoster } from "../lib/post.ts";
import { fetchTagActivity, lastDays } from "../lib/litellm.ts";
import { renderReport } from "../lib/report.ts";
import { command } from "./hint.ts";

export async function runReport(argv: string[]): Promise<void> {
  const run = (...args: string[]) => command("report", args);

  const USAGE = `Usage: ${run("[TICKET-KEY | --branch <name>]", "[--days <n>]", "[--post]")}

    --branch <name>  Read the ticket from this branch name instead (e.g. a merged PR's branch in CI)
    --days <n>   Look back this many days, today included (default 30)
    --post       Create or update the report comment on the ticket (Linear or Jira)

  Environment (.env.local here or in the main checkout): LITELLM_BASE_URL, LITELLM_API_KEY; for --post, LINEAR_API_KEY or JIRA_BASE_URL + JIRA_EMAIL + JIRA_API_TOKEN`;

  function fail(message: string): never {
    console.error(`\n✖ ${message}\n`);
    process.exit(1);
  }


  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      days: { type: "string", default: "30" },
      branch: { type: "string" },
      post: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  // A stray second positional is usually the value of a flag npm ate
  // (`--days 60` before `--`). Refuse it rather than use the default.
  if (positionals.length > 1) fail(`Unexpected argument "${positionals[1]}".\n\n${USAGE}`);

  const mainRoot = mainCheckoutRoot();
  // Ticket worktrees have no .env.local of their own (it's gitignored).
  loadEnvLocal([tryGit(["rev-parse", "--show-toplevel"]) ?? process.cwd(), mainRoot]);
  const contract = loadContract(mainRoot);
  const branch = values.branch ?? currentBranch();
  const key = positionals[0]
    ? (normalizeTicketKey(positionals[0], contract) ?? fail(`"${positionals[0]}" is not a ticket key.`))
    : ((branch && findTicketKey(branch, contract)) ?? noTicket());

  function noTicket(): never {
    // In CI (`--branch` from a merged PR), a branch like dependabot/... is normal.
    if (values.branch) {
      console.log(`Branch "${values.branch}" doesn't name a ticket. Nothing to report.`);
      process.exit(0);
    }
    fail(`Branch "${branch ?? "(detached)"}" doesn't name a ticket. Pass a key: ${run("ENG-123")}`);
  }

  // Check posting credentials before reading any spend.
  const poster = values.post ? reportPoster(contract.tracker) : null;
  if (typeof poster === "string") fail(poster);

  const days = Number.parseInt(values.days, 10);
  if (!Number.isInteger(days) || days < 1) fail("--days must be a positive whole number.");

  const apiKey = process.env.LITELLM_API_KEY;
  if (!apiKey) {
    const ledger = contract.automation.ledger_url;
    if (ledger && !values.post) {
      console.log(`\n${key}'s spend is in the ledger: ${new URL(`/tickets/${encodeURIComponent(key)}`, ledger)}\n`);
      process.exit(0);
    }
    fail("Set LITELLM_BASE_URL and LITELLM_API_KEY in the environment or .env.local (keep .env.local out of git). The key reads the whole organization's spend, so it belongs in CI or with a lead, not on every laptop.");
  }
  const baseUrl = process.env.LITELLM_BASE_URL || "http://localhost:4000";

  const tag = ticketTag(key);
  const range = lastDays(days);

  try {
    const detail = summarizeTicket(key, await fetchTagActivity({ tags: [tag], ...range }, { baseUrl, apiKey }));

    if (!detail) {
      console.log(
        `\nNo spend recorded for ${key} (tag ${tag}) between ${range.startDate} and ${range.endDate}.\n` +
          "If you worked on it, check the tokens-per-ticket warnings at the start of that Claude Code session: gateway, key, and registry.\n" +
          "LiteLLM also writes spend in batches, so calls from the last minute may not show yet.\n",
      );
      process.exit(0);
    }

    const report = renderReport({ detail, tag, range, generatedAt: new Date() });
    console.log(`\n${report}\n`);

    if (poster && typeof poster !== "string") {
      const { identifier, url, action } = await poster({ key, body: report });
      console.log(`✓ Report comment ${action} on ${identifier}: ${url}`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
