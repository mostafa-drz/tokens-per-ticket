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
 *   4. /ticket-cost and /ticket-start skills
 *   5. the prepare-commit-msg hook for the commit trailer
 *   6. .env.local in .gitignore: `tpt report` reads an org-wide spend key from it
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
    if (existsSync(file)) continue;
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
  for (const rule of [`Bash(node ${BUNDLE_PATH} report *)`, `Bash(node ${BUNDLE_PATH} start *)`]) {
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
description: Report what a ticket has cost in AI tokens so far, from the LiteLLM gateway, and point out anything worth discussing (model mix, prompt cache use, failed calls). Use when the user asks what this ticket or ENG-123 has cost, or wants the spend posted to the tracker.
argument-hint: "[TICKET-KEY] [--days N] [--post]"
allowed-tools: Bash(node ${BUNDLE_PATH} report *)
---

# Ticket cost

1. Run \`node ${BUNDLE_PATH} report $ARGUMENTS\`. With no key it reads the ticket from the current branch.
   Only add \`--post\` when the user explicitly asked to post or update the tracker comment.
2. If it fails, relay the error as is. The messages say how to fix the problem.
3. Otherwise show the report, then at most three short observations the numbers support
   (model mix on routine work, low prompt-cache share, failed requests, many active days).

The number is a signal to talk about, not a score.
`,
  "ticket-start": `---
name: ticket-start
description: Prepare a separate worktree for a ticket and give the user the command that starts a Claude Code session in it. Only needed to work two tickets side by side; on a ticket branch, spend is attributed automatically.
argument-hint: "<TICKET-KEY> [short title]"
disable-model-invocation: true
allowed-tools: Bash(node ${BUNDLE_PATH} start *)
---

# Start a ticket in its own worktree

1. Run \`node ${BUNDLE_PATH} start $ARGUMENTS --print\`.
2. If it fails, relay the error as is.
3. Otherwise tell the user which branch and worktree are ready, and that they can open a new terminal and paste the printed command.

Don't run the printed \`claude\` command yourself.
`,
};
