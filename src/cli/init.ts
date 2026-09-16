import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CONTRACT_FILE, loadContract } from "../lib/contract.ts";
import { tryGit } from "../lib/git.ts";
import { ensureCommitTrailerHook } from "./git-trailer.ts";
import { BUNDLE_PATH } from "./hint.ts";
import { hookSettings } from "./hook.ts";

/**
 * tpt init: adopt tokens-per-ticket in the current repository, once.
 *
 *   1. tokens-per-ticket.yaml, unless the repo already has one
 *   2. .tokens-per-ticket/tpt.mjs, this CLI as one file with no dependencies
 *   3. hooks and permissions merged into .claude/settings.json (nothing removed)
 *   4. the /ticket-cost skill
 *   5. the prepare-commit-msg hook for the commit trailer
 *   6. .env.local in .gitignore: the spend-reading key belongs there, not in git
 *
 * Safe to run again: it only adds what's missing, and refreshes the bundle.
 */

declare const __DEFAULT_CONFIG__: string | undefined;

const USAGE = `Usage: node <path-to>/tpt.mjs init --teams <ENG,WEB> [--registry-url <url>] [--dir <repo>]

  --teams <keys>        Your tracker's team keys. Without them, branches like fix/utf-8-parsing read as ticket UTF-8
  --registry-url <url>  The session registry next to your LiteLLM gateway
  --dir <repo>          Repository to set up (default: the current one)`;

export async function runInit(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "registry-url": { type: "string" },
      teams: { type: "string" },
      dir: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const root = tryGit(["rev-parse", "--show-toplevel"], values.dir ?? process.cwd());
  if (!root) {
    console.error("\n✖ Run init inside a git repository (or pass --dir).\n");
    process.exit(1);
  }
  const done: string[] = [];

  // 1. Config
  const configFile = path.join(root, CONTRACT_FILE);
  const registryUrl = values["registry-url"];
  if (registryUrl && !/^https?:\/\/[^/]/.test(registryUrl)) {
    console.error(`\n✖ --registry-url must be a full http(s) URL, such as https://litellm.your-company.dev:4100\n`);
    process.exit(1);
  }
  const teams = (values.teams ?? "").split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (teams.some((t) => !/^[A-Z][A-Z0-9]*$/.test(t))) {
    console.error(`\n✖ --teams takes team keys such as ENG,WEB.\n`);
    process.exit(1);
  }
  if (registryUrl && registryUrl.startsWith("http:") && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]?/.test(registryUrl)) {
    done.push("⚠ --registry-url is plain HTTP: hooks send each engineer's gateway key there. Use HTTPS outside localhost");
  }
  if (existsSync(configFile)) {
    done.push(`kept your ${CONTRACT_FILE}${registryUrl || teams.length ? " (edit it directly; --registry-url and --teams only apply to a new file)" : ""}`);
  } else {
    let config = defaultConfig();
    if (!registryUrl) done.push("⚠ automation.registry_url is http://localhost:4100, which only works on the gateway's own machine. Pass --registry-url, or set TPT_REGISTRY_URL for everyone through managed settings");
    if (registryUrl) config = config.replace(/registry_url: ".*"/, `registry_url: "${registryUrl}"`);
    if (teams.length) config = config.replace(/teams: \[\]/, `teams: [${teams.join(", ")}]`);
    writeFileSync(configFile, config);
    done.push(`wrote ${CONTRACT_FILE} (Linear-style branches; edit it if yours differ)`);
  }
  const contract = loadContract(root);
  if (contract.key.teams.length === 0) {
    done.push(`⚠ key.teams is empty, so any branch shaped like the template counts, e.g. fix/utf-8-parsing as UTF-8. Add your team keys to ${CONTRACT_FILE}`);
  }

  // 2. Bundle
  const self = fileURLToPath(import.meta.url);
  const bundle = path.join(root, BUNDLE_PATH);
  if (!self.endsWith(".mjs")) {
    console.error("\n✖ Run init from the built CLI (.tokens-per-ticket/tpt.mjs), not the TypeScript source. Build it with `pnpm build:cli`.\n");
    process.exit(1);
  }
  if (path.resolve(self) !== path.resolve(bundle)) {
    mkdirSync(path.dirname(bundle), { recursive: true });
    copyFileSync(self, bundle);
    done.push(`copied the CLI to ${BUNDLE_PATH}`);
  }

  // 3. Claude Code settings
  const settingsFile = path.join(root, ".claude", "settings.json");
  const settings = readSettings(settingsFile);
  const added = mergeHookSettings(settings);
  if (added.length) {
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    done.push(`.claude/settings.json: ${added.join(", ")}`);
  } else {
    done.push(".claude/settings.json already has the hooks");
  }

  // 4. Skills
  for (const [name, text] of Object.entries(SKILLS)) {
    const file = path.join(root, ".claude", "skills", name, "SKILL.md");
    if (existsSync(file)) {
      // Teams are meant to edit these, so never overwrite one. Say when it
      // differs, because an older version can name a command that's gone.
      if (readFileSync(file, "utf8") !== text) {
        done.push(`kept your /${name} skill, which differs from this version. Delete it and re-run init to take the new one`);
      }
      continue;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    done.push(`added the /${name} skill`);
  }

  // 5. Commit trailer hook
  const hook = ensureCommitTrailerHook(root, contract);
  if (hook === "installed" || hook === "present") done.push(`commit trailer "${contract.automation.commit_trailer}: <KEY>" is on`);
  if (hook === "elsewhere") {
    done.push(`git hooks live in core.hooksPath, not .git/hooks, so the commit trailer was not installed. Add \`node ${BUNDLE_PATH} git-trailer "$@"\` to its prepare-commit-msg`);
  }
  if (hook === "foreign") {
    done.push(
      `a prepare-commit-msg hook already exists, so the commit trailer was not installed. To keep both, call \`node ${BUNDLE_PATH} git-trailer "$@"\` from it`,
    );
  }

  // 6. Keep the spend key out of git
  if (tryGit(["check-ignore", "-q", ".env.local"], root) === null) {
    const gitignore = path.join(root, ".gitignore");
    const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
    appendFileSync(gitignore, `${current && !current.endsWith("\n") ? "\n" : ""}.env.local\n`);
    done.push("added .env.local to .gitignore");
  }

  console.log(`\n✓ tokens-per-ticket is set up in ${root}\n`);
  for (const line of done) console.log(`  • ${line}`);
  console.log(`
Next:
  1. Commit ${CONTRACT_FILE}, ${path.dirname(BUNDLE_PATH)}/, .claude/, and .gitignore so every clone and worktree has them.
  2. Each engineer, once (or your org, through managed settings), in ~/.claude/settings.json:
       "env": { "ANTHROPIC_BASE_URL": "<your LiteLLM URL>", "ANTHROPIC_AUTH_TOKEN": "<their gateway key>" }
  That's it. Sessions on ticket branches are attributed automatically, including branch switches.
`);
}

function defaultConfig(): string {
  if (typeof __DEFAULT_CONFIG__ === "string") return __DEFAULT_CONFIG__;
  // Running from source: read the repo's own file.
  return readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", CONTRACT_FILE), "utf8");
}

type Settings = { hooks?: Record<string, { matcher?: string; hooks: { command?: string; args?: string[] }[] }[]>; permissions?: { allow?: string[] } };

function readSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`\n✖ ${file} isn't valid JSON, so init won't touch it: ${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  }
}

/**
 * Adds the tokens-per-ticket hooks and permissions that aren't there yet, and
 * replaces tokens-per-ticket hooks written by an older version. Everything
 * else in the file is kept. Returns what it changed.
 */
export function mergeHookSettings(settings: Settings): string[] {
  const added: string[] = [];
  settings.hooks ??= {};
  const ours = (handler: { command?: string; args?: string[] }) =>
    [handler.command, ...(handler.args ?? [])].some((part) => part?.includes(BUNDLE_PATH));
  for (const [event, groups] of Object.entries(hookSettings())) {
    const wanted = groups as NonNullable<Settings["hooks"]>[string];
    const existing = settings.hooks[event] ?? [];
    const current = existing.filter((group) => group.hooks?.some(ours));
    if (current.length === 1 && JSON.stringify(current[0]) === JSON.stringify(wanted[0])) continue;
    const others = existing
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((handler) => !ours(handler)) }))
      .filter((group) => group.hooks.length > 0);
    settings.hooks[event] = [...others, ...wanted];
    added.push(`${current.length ? "updated" : "added"} ${event} hook`);
  }
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  for (const rule of [`Bash(node ${BUNDLE_PATH} ticket*)`]) {
    if (!settings.permissions.allow.includes(rule)) {
      settings.permissions.allow.push(rule);
      added.push(`permission ${rule}`);
    }
  }
  return added;
}

const SKILLS: Record<string, string> = {
  "ticket-cost": `---
name: ticket-cost
description: What a ticket has cost in AI tokens so far, read from the LiteLLM gateway, with the numbers worth discussing. Optionally posts or updates the figures as a comment on the ticket through the tracker's MCP server. Use when the user asks what this ticket or ENG-123 has cost.
argument-hint: "[TICKET-KEY] [--days N] [--post]"
allowed-tools: Bash(node ${BUNDLE_PATH} ticket*), Bash(curl -sS -H * "$LITELLM_BASE_URL/tag/daily/activity*)
---

# What this ticket cost

## 1. The ticket

Use the key the user gave. Otherwise run \`node ${BUNDLE_PATH} ticket\`, which prints
\`<KEY> <tag>\` for the current branch, or explains why the branch names no ticket. The spend tag
is always \`ticket:<KEY>\`.

## 2. The numbers

Read them straight from the gateway (default 30 days; \`--days N\` changes the window):

\`\`\`bash
curl -sS -H "Authorization: Bearer $LITELLM_API_KEY" \\
  "$LITELLM_BASE_URL/tag/daily/activity?tags=<tag>&start_date=<YYYY-MM-DD>&end_date=<today>&page_size=1000"
\`\`\`

\`LITELLM_BASE_URL\` and \`LITELLM_API_KEY\` come from the environment or \`.env.local\`. That key reads
the whole organization's spend, so most laptops don't have it: if it's missing, say so and stop.

Each day in \`results\` carries \`metrics\` (spend, prompt_tokens, completion_tokens,
cache_read_input_tokens, api_requests, failed_requests) and \`breakdown.model_groups\` per model.
Sum the days for the totals. \`prompt_tokens\` already includes cache reads and writes.

## 3. Say what matters

Give the totals (spend, tokens, requests, active days) and the split by model, then at most three
observations the numbers support: an expensive model on routine work, a low prompt-cache share,
failed requests, spend spread over many days. Tokens per ticket is a signal to talk about, not a
score to rank people by. Say plainly when nothing is worth flagging.

## 4. Only with --post: put it on the ticket

Use the tracker's MCP server (Linear, Jira, or whatever this team runs), never a hand-written API
call. If no tracker MCP server is connected, show the comment text and say it can be pasted in.

Keep exactly one comment per ticket: list the ticket's comments, and if one of yours ends with
\`_Updated by tokens-per-ticket_\`, update that comment instead of adding another. Write the figures
as a small Markdown table, name the tag and the date range, and end with that line.
`,
};
