/**
 * tpt: the tokens-per-ticket CLI. Built into one dependency-free file,
 * .tokens-per-ticket/tpt.mjs, which adopting repos commit.
 *
 *   node .tokens-per-ticket/tpt.mjs hook              Claude Code hook (reads JSON on stdin)
 *   node .tokens-per-ticket/tpt.mjs git-trailer ...   git prepare-commit-msg hook
 *   node .tokens-per-ticket/tpt.mjs init              set up a repository
 *   node .tokens-per-ticket/tpt.mjs report [KEY]      what a ticket has cost
 */
import { readFileSync } from "node:fs";
import { runGitTrailer } from "./git-trailer.ts";
import { handleHook, type HookInput } from "./hook.ts";
import { runInit } from "./init.ts";
import { runReport } from "./report.ts";

const USAGE = `tokens-per-ticket

  init --teams <ENG,WEB> [--registry-url <url>]
                                Set up this repository (once)
  report [KEY] [--days N] [--post]
                                What a ticket has cost, from LiteLLM
  hook                          Claude Code hook (used by .claude/settings.json)
  git-trailer <file> [source]   git prepare-commit-msg hook`;

export async function main(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "hook": {
      let input: HookInput = {};
      try {
        input = JSON.parse(readFileSync(0, "utf8"));
      } catch {
        // No stdin (run by hand): treat as a session start in the current directory.
        input = { hook_event_name: "SessionStart", cwd: process.cwd() };
      }
      try {
        process.stdout.write(JSON.stringify(await handleHook(input)));
      } catch (error) {
        // A hook must never break the session.
        process.stdout.write(JSON.stringify({ systemMessage: `tokens-per-ticket hook error: ${error instanceof Error ? error.message : error}` }));
      }
      // Claude Code waits for the process to exit. A registry request that
      // timed out can still hold a socket open for seconds, so don't wait for it.
      process.stdout.write("", () => process.exit(0));
      return;
    }
    case "git-trailer":
      return runGitTrailer(rest);
    case "init":
      return runInit(rest);
    case "report":
      return runReport(rest);
    default:
      console.log(USAGE);
      if (sub && sub !== "help" && sub !== "--help" && sub !== "-h") process.exitCode = 1;
  }
}

await main(process.argv.slice(2));
