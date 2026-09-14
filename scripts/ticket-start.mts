/**
 * pnpm ticket:start ENG-123 "checkout flow"
 *
 * Starts work on a ticket the way the contract expects:
 *   1. a branch named by ticket-contract.yaml
 *   2. its own git worktree (your current checkout is never switched)
 *   3. Claude Code launched in that worktree, tagging every model call
 *      with ticket:ENG-123
 *
 * Re-running for the same ticket reuses the existing worktree.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { parseArgs } from "node:util";
import {
  branchName,
  findTicketKey,
  loadContract,
  normalizeTicketKey,
  ticketTag,
  worktreePath,
} from "../src/lib/contract.ts";
import { branchExists, git, listWorktrees, localBranches, mainCheckoutRoot, tryGit } from "../src/lib/git.ts";
import { claudeArgs, shellCommand, ticketBranches, userSettingsEnv, withTicketTag } from "../src/lib/launch.ts";

const USAGE = `Usage: pnpm ticket:start <TICKET-KEY> [short title] [--base <ref>] [--print]

  --base <ref>   Branch point for a new branch (default: HEAD of the main checkout)
  --print        Create the worktree and print the claude command instead of launching it`;

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: "string" },
    print: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help || positionals.length === 0) {
  console.log(USAGE);
  process.exit(positionals.length === 0 && !values.help ? 1 : 0);
}

const repoRoot = tryGit(["rev-parse", "--show-toplevel"]) ?? fail("Run this inside the repository.");
const mainRoot = mainCheckoutRoot(repoRoot);
const contract = loadContract(mainRoot);

const key =
  normalizeTicketKey(positionals[0], contract) ??
  fail(`"${positionals[0]}" is not a ticket key. ticket-contract.yaml expects /${contract.key.pattern}/.`);
const title = positionals.slice(1).join(" ");
const tag = ticketTag(key, contract);

// 1 + 2. Find or create the worktree for this ticket.
const existing = listWorktrees(mainRoot).find((wt) => wt.branch && findTicketKey(wt.branch, contract) === key);

let worktree: string;
let branch: string;

if (existing?.branch) {
  worktree = existing.path;
  branch = existing.branch;
  console.log(`↺ Reusing worktree for ${key}: ${worktree}`);
} else {
  const known = ticketBranches(localBranches(mainRoot), key, contract);
  if (known.length > 1) {
    fail(`Several local branches name ${key}: ${known.join(", ")}. Delete or rename all but one, then run this again.`);
  }

  const user = process.env.TICKET_USER ?? tryGit(["config", "user.name"]) ?? os.userInfo().username;
  branch = known[0] ?? branchName({ user, key, slug: title }, contract);
  worktree = worktreePath({ repoRoot: mainRoot, branch }, contract);
  if (existsSync(worktree)) fail(`${worktree} already exists but is not a worktree for ${key}. Move it first.`);

  if (branchExists(branch, mainRoot)) {
    git(["worktree", "add", worktree, branch], mainRoot);
    console.log(`✓ Using existing branch ${branch}`);
  } else {
    git(["worktree", "add", "-b", branch, worktree, values.base ?? "HEAD"], mainRoot);
    console.log(`✓ Created ${branch}`);
  }
  console.log(`✓ Worktree ${worktree}`);
  console.log("  Run `pnpm install` there before running the app or tests.");
}

// 3. Launch Claude Code with the ticket tag.
const userEnv = userSettingsEnv();
const headers = withTicketTag(
  process.env.ANTHROPIC_CUSTOM_HEADERS ?? userEnv.ANTHROPIC_CUSTOM_HEADERS,
  tag,
  contract.tag.prefix,
);
const args = claudeArgs({ key, headers });

if (!process.env.ANTHROPIC_BASE_URL && !userEnv.ANTHROPIC_BASE_URL) {
  console.warn(
    "\n⚠ ANTHROPIC_BASE_URL is not set in your shell or ~/.claude/settings.json.\n" +
      "  Claude Code will call Anthropic directly and LiteLLM will never see this ticket's tokens.\n" +
      "  See README → Connect Claude Code to the gateway.",
  );
}

console.log(`\n→ Every model call in this session is tagged ${tag}`);

if (values.print || !process.stdout.isTTY) {
  console.log(`\ncd ${shellCommand(worktree, []).trim()} && ${shellCommand("claude", args)}\n`);
  process.exit(0);
}

const child = spawn("claude", args, { cwd: worktree, stdio: "inherit" });
child.on("error", (error) => fail(`Could not start claude: ${error.message}`));
child.on("exit", (code) => process.exit(code ?? 0));
