import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findTicketKey, type TicketContract } from "./contract.ts";

/** Helpers for `tpt start`, which opens a worktree and a Claude Code session per ticket. */

/**
 * Names the session after the ticket. Attribution needs nothing else: the
 * worktree's branch is reported by the hooks, and the gateway tags the calls.
 */
export function claudeArgs(input: { key: string }): string[] {
  return ["--name", input.key];
}

/** Local branches that belong to the ticket, whatever their title. */
export function ticketBranches(branches: string[], key: string, contract: TicketContract): string[] {
  return branches.filter((branch) => findTicketKey(branch, contract) === key);
}

/** Quotes arguments so the printed command can be pasted into a POSIX shell. */
export function shellCommand(command: string, args: string[]): string {
  const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);
  return [command, ...args].map(quote).join(" ");
}

/** The `env` block from ~/.claude/settings.json, if any. */
export function userSettingsEnv(home: string = os.homedir()): Record<string, string> {
  try {
    const settings = JSON.parse(readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    return settings?.env && typeof settings.env === "object" ? settings.env : {};
  } catch {
    return {};
  }
}
