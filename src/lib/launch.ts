import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * How `pnpm ticket:start` hands the ticket to Claude Code.
 *
 * Claude Code sends ANTHROPIC_CUSTOM_HEADERS on every request, and LiteLLM
 * turns an `x-litellm-tags` header into spend tags. The value is fixed for the
 * session, which is why the repo pairs it with one worktree per ticket.
 *
 * It is passed with `claude --settings` rather than a shell export: a settings
 * file `env` block overrides a shell variable of the same name, so an export
 * could be silently ignored. Command-line settings sit above user and project
 * settings. https://code.claude.com/docs/en/settings
 */

const TAGS_HEADER = "x-litellm-tags";

/**
 * Adds the ticket tag to a newline-separated header list, keeping any other
 * headers and non-ticket tags the developer already sends.
 */
export function withTicketTag(existingHeaders: string | undefined, tag: string, ticketPrefix: string): string {
  const lines = (existingHeaders ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const others: string[] = [];
  const tags: string[] = [];
  for (const line of lines) {
    const separator = line.indexOf(":");
    const name = separator === -1 ? line : line.slice(0, separator).trim();
    if (name.toLowerCase() !== TAGS_HEADER) {
      others.push(line);
      continue;
    }
    for (const existing of line.slice(separator + 1).split(",")) {
      const value = existing.trim();
      if (value && !value.startsWith(ticketPrefix)) tags.push(value);
    }
  }

  return [...others, `${TAGS_HEADER}: ${[...tags, tag].join(",")}`].join("\n");
}

export function claudeArgs(input: { key: string; headers: string }): string[] {
  return ["--settings", JSON.stringify({ env: { ANTHROPIC_CUSTOM_HEADERS: input.headers } }), "--name", input.key];
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
