#!/usr/bin/env node
/**
 * SessionStart hook: says which ticket this Claude Code session is billed to,
 * and warns when the branch and the session's spend tag disagree.
 *
 * It can't fix a wrong tag. The header is fixed when Claude Code starts, so
 * the fix is always "exit and run ticket:start <KEY>" (in the repo's package manager).
 *
 * Input: SessionStart JSON on stdin (https://code.claude.com/docs/en/hooks).
 * Output: additionalContext for Claude, systemMessage for you, sessionTitle.
 * Never blocks: every path exits 0.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function respond({ context, warning, title }) {
  const output = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } };
  if (title) output.hookSpecificOutput.sessionTitle = title;
  if (warning) output.systemMessage = warning;
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  // Run by hand without stdin: fall back to the current directory.
}
const cwd = input.cwd ?? process.cwd();

// Where the TypeScript helpers live. If you copied them somewhere other than
// src/lib, change this one line.
const LIB_DIR = "src/lib";

// The contract helpers are TypeScript. A fresh worktree has no node_modules
// yet, so skip quietly instead of failing the session start.
let tsImport;
try {
  ({ tsImport } = await import("tsx/esm/api"));
} catch {
  respond({
    context:
      "tokens-per-ticket: the ticket check was skipped because dependencies (tsx) aren't installed in this worktree. Suggest installing them with this repository's package manager.",
  });
}

// Anything else that goes wrong while loading is a setup problem, not a fresh
// worktree, so say what failed instead of suggesting an install that won't help.
let contractModule;
let packageManager;
let contract;
try {
  const load = (file) => tsImport(pathToFileURL(path.join(projectDir, LIB_DIR, file)).href, import.meta.url);
  contractModule = await load("contract.ts");
  packageManager = await load("package-manager.ts");
  contract = contractModule.loadContract(projectDir);
} catch (error) {
  const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
  respond({
    context: `tokens-per-ticket: the ticket check could not run: ${reason}`,
    warning: `tokens-per-ticket hook could not load ${LIB_DIR}/contract.ts, ${LIB_DIR}/package-manager.ts, or ticket-contract.yaml from ${projectDir}: ${reason}`,
  });
}

const { findTicketKey, keyFromTag, ticketTag } = contractModule;
const manager = packageManager.detectPackageManager(projectDir);
const startCommand = (key) => packageManager.scriptCommand(manager, "ticket:start", [key]);

let branch = "";
try {
  branch = execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim();
} catch {
  // Not a git checkout.
}

const branchKey = branch ? findTicketKey(branch, contract) : null;
const sessionKeys = (process.env.ANTHROPIC_CUSTOM_HEADERS ?? "")
  .split("\n")
  .filter((line) => line.toLowerCase().startsWith("x-litellm-tags:"))
  .flatMap((line) => line.slice(line.indexOf(":") + 1).split(","))
  .map((tag) => keyFromTag(tag.trim(), contract))
  .filter(Boolean);
const sessionKey = sessionKeys[0] ?? null;
const baseUrl = process.env.ANTHROPIC_BASE_URL;

if (!baseUrl) {
  respond({
    context:
      "tokens-per-ticket: ANTHROPIC_BASE_URL is not set, so this session talks to the provider directly and no tokens are attributed to any ticket.",
    warning: "Not connected to the LiteLLM gateway: this session's tokens won't be counted. See README → Connect Claude Code to the gateway.",
    title: branchKey ?? undefined,
  });
}

if (branchKey && sessionKey === branchKey) {
  respond({
    context: `tokens-per-ticket: this session is billed to ticket ${branchKey} (every model call is tagged ${ticketTag(branchKey, contract)}). Keep the work scoped to ${branchKey}. For another ticket, the user should run \`${startCommand("<KEY>")}\`, which opens a separate worktree and session.`,
    title: branchKey,
  });
}

if (branchKey && !sessionKey) {
  respond({
    context: `tokens-per-ticket: the branch is for ${branchKey}, but this session was not started with its ticket tag, so its tokens are not attributed to ${branchKey}.`,
    warning: `Tokens in this session are not counted against ${branchKey}. Exit and run: ${startCommand(branchKey)}`,
    title: branchKey,
  });
}

if (branchKey && sessionKey !== branchKey) {
  respond({
    context: `tokens-per-ticket: the branch is for ${branchKey}, but this session's tokens are tagged ${sessionKey}. Mention this mismatch to the user before doing work.`,
    warning: `Branch is ${branchKey} but this session bills ${sessionKey}. Exit and run: ${startCommand(branchKey)}`,
    title: branchKey,
  });
}

if (sessionKey) {
  respond({
    context: `tokens-per-ticket: this session bills ${sessionKey}, but branch "${branch || "(none)"}" doesn't follow ticket-contract.yaml.`,
    warning: `Session bills ${sessionKey}, but the branch doesn't name it. Commits here won't link back to the ticket.`,
    title: sessionKey,
  });
}

respond({
  context: `tokens-per-ticket: not on a ticket branch ("${branch || "(none)"}"), so this session's tokens aren't attributed to a ticket. That's fine for exploration. To work a ticket, the user runs \`${startCommand("<KEY>")}\`.`,
});
