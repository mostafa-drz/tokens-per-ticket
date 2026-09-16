import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONTRACT_FILE, findTicketKey, keyFromTag, loadContract, type TicketContract } from "../lib/contract.ts";
import { reportSession, type SessionReport } from "../lib/registry-client.ts";
import { ensureCommitTrailerHook } from "./git-trailer.ts";
import { BUNDLE_PATH } from "./hint.ts";

/**
 * The Claude Code hook behind automatic attribution. One handler for:
 *
 * - SessionStart: report the session's ticket, watch .git/HEAD, name the session.
 * - FileChanged (.git/HEAD): the branch moved, from Claude or from anywhere else.
 * - CwdChanged: the session moved into another checkout.
 * - UserPromptSubmit: a cheap re-check before each prompt, in case an event was missed.
 *
 * The registry keeps "session -> ticket", and the gateway plugin tags every
 * model call from it. Hook input and output formats:
 * https://code.claude.com/docs/en/hooks
 *
 * It never blocks and never fails the session: every path returns output.
 */

export type HookInput = {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  source?: string;
  session_title?: string;
  file_path?: string;
  new_cwd?: string;
};

export type HookOutput = {
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    sessionTitle?: string;
    watchPaths?: string[];
  };
  systemMessage?: string;
};

type Env = Record<string, string | undefined>;

type Deps = {
  report: typeof reportSession;
  stateDir: string;
  now: () => number;
};

/** In the repository's git directory, never in the working tree. */
const FALLBACK_CLI = "tokens-per-ticket.mjs";
const REPORT_EVERY_MS = 10 * 60_000;
const RETRY_FAILED_MS = 60_000;

export async function handleHook(input: HookInput, env: Env = process.env, deps: Partial<Deps> = {}): Promise<HookOutput> {
  const { report, stateDir, now } = {
    report: reportSession,
    stateDir: defaultStateDir(),
    now: Date.now,
    ...deps,
  };
  const event = input.hook_event_name ?? "unknown";
  const cwd = input.new_cwd ?? input.cwd ?? process.cwd();

  const root = git(["rev-parse", "--show-toplevel"], cwd);
  // Only the project Claude Code was started in (or a worktree of it) is
  // trusted: a directory the session merely moves into doesn't get to name a
  // registry for the key, or install a git hook.
  if (!root || !existsSync(path.join(root, CONTRACT_FILE)) || !sameRepo(root, env.CLAUDE_PROJECT_DIR)) {
    // Not set up here: another repo, or a branch from before adoption. A
    // session that was on a ticket must stop counting toward it.
    const headPath = root ? git(["rev-parse", "--path-format=absolute", "--git-path", "HEAD"], cwd) : "";
    const watchPaths = event === "FileChanged" && headPath ? [headPath] : undefined;
    const left = input.session_id ? await leaveTicket(input.session_id, env, { report, stateDir, now }) : null;
    if (left) {
      const here = !root
        ? "this directory isn't a git repository"
        : existsSync(path.join(root, CONTRACT_FILE))
          ? "this is a different repository"
          : "this branch predates tokens-per-ticket (merge your default branch into it to attribute it)";
      return withEvent(event, {
        watchPaths,
        systemMessage: left.ok
          ? `tokens-per-ticket: ${here}, so the session no longer counts toward ${left.ticket}.`
          : `tokens-per-ticket: ${here}, but the registry couldn't be told (${left.reason.replace(/\.$/, "")}), so calls may still count toward ${left.ticket}. It retries within a minute, on your next prompt.`,
      });
    }
    return event === "SessionStart" || event === "CwdChanged" || watchPaths ? withEvent(event, { watchPaths }) : {};
  }

  let contract: TicketContract;
  try {
    contract = loadContract(root);
  } catch (error) {
    return withEvent(event, {
      systemMessage: `tokens-per-ticket: ${CONTRACT_FILE} is invalid, so this session isn't attributed: ${firstLine(error)}`,
    });
  }

  const branch = git(["branch", "--show-current"], cwd) || null;
  const ticket = branch ? findTicketKey(branch, contract) : null;
  const headPath = git(["rev-parse", "--path-format=absolute", "--git-path", "HEAD"], cwd);
  const watchPaths = headPath ? [headPath] : [];
  const headerTicket = headerTicketTag(env.ANTHROPIC_CUSTOM_HEADERS, contract);

  const startEvent = event === "SessionStart" || event === "CwdChanged";
  if (startEvent) ensureCommitTrailerHook(root, contract);
  if (event === "SessionStart") {
    pruneState(stateDir, now);
    keepFallbackCopy(root);
  }

  const title = event === "SessionStart" && ticket && !input.session_title && input.source !== "clear" && input.source !== "compact" ? ticket : undefined;

  // Where calls go and who makes them. Without both, the registry can't help.
  const problems: string[] = [];
  if (!env.ANTHROPIC_BASE_URL) problems.push("Claude Code isn't pointed at the LiteLLM gateway (ANTHROPIC_BASE_URL is not set), so no spend from this session reaches it.");

  const registryUrl = env.TPT_REGISTRY_URL || contract.automation.registry_url;
  const gatewayKey = gatewayKeyFrom(env);
  const automatic = contract.automation.sessions && registryUrl;

  let reported: "sent" | "skipped" | "failed" = "skipped";
  // Whether the registry has this session's current ticket, as far as we know.
  let registered = false;
  let failure = "";
  if (automatic && env.ANTHROPIC_BASE_URL && input.session_id) {
    if (!gatewayKey) {
      problems.push("No gateway key in ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, or x-litellm-api-key in ANTHROPIC_CUSTOM_HEADERS, so this session can't be reported to the registry.");
    } else {
      const stateId = input.session_id;
      const state = readState(stateDir, stateId);
      const changed = !state || state.ticket !== ticket || state.branch !== branch || state.root !== root;
      // After a failure, retry at most once a minute: a registry that drops
      // packets would otherwise add its timeout to every prompt.
      const due = !state || now() - state.at > (state.failed ? RETRY_FAILED_MS : REPORT_EVERY_MS);
      // SessionStart and a moved HEAD always report; a prompt or a cd only when something changed.
      if (event === "SessionStart" || event === "FileChanged" || changed || due) {
        const payload: SessionReport = { session_id: input.session_id, ticket, event };
        const result = await report(payload, { registryUrl, gatewayKey });
        reported = result.ok ? "sent" : "failed";
        if (!result.ok) failure = result.reason;
        const alreadyWarned = state?.failed && state.reason === failure;
        writeState(stateDir, stateId, { ticket, branch, root, registryUrl, at: now(), failed: !result.ok, reason: failure });
        if (!result.ok && alreadyWarned && event === "UserPromptSubmit") return {};
      } else {
        registered = state?.failed === false;
      }
      if (reported === "sent") registered = true;
      if (reported === "failed") problems.push(`Couldn't report this session to the registry: ${failure.replace(/\.$/, "")}. Until that works, its spend isn't attributed, or still counts toward the ticket it was last reported on.`);
    }
  }

  // The gateway refuses requests that carry their own ticket tag, so a leftover
  // header would break every call in the session.
  if (headerTicket) {
    problems.push(`ANTHROPIC_CUSTOM_HEADERS sets ticket ${headerTicket} in x-litellm-tags, but the gateway sets tickets itself and refuses those calls. Remove that entry.`);
  }

  const billedTo = registered ? ticket : null;
  const context = billedTo
    ? `tokens-per-ticket: model calls in this session count toward ticket ${billedTo}, following the current branch automatically.`
    : ticket
      ? `tokens-per-ticket: this session's spend isn't attributed to ${ticket} yet; see the tokens-per-ticket warning for what's missing.`
      : `tokens-per-ticket: branch "${branch ?? "(detached)"}" doesn't name a ticket, so this session's spend isn't attributed to one.`;

  if (event === "UserPromptSubmit") {
    return problems.length && reported === "failed" ? { systemMessage: `tokens-per-ticket: ${problems.join(" ")}` } : {};
  }

  if (event === "FileChanged" || event === "CwdChanged") {
    const moved = reported === "sent" ? `tokens-per-ticket: now counting toward ${ticket ?? "no ticket"} (${branch ?? "detached HEAD"}).` : undefined;
    return withEvent(event, {
      watchPaths,
      systemMessage: problems.length ? `tokens-per-ticket: ${problems.join(" ")}` : moved,
    });
  }

  return withEvent(event, {
    additionalContext: startEvent ? context : undefined,
    sessionTitle: title,
    watchPaths,
    systemMessage: problems.length ? `tokens-per-ticket: ${problems.join(" ")}` : undefined,
  });
}

function withEvent(event: string, fields: { additionalContext?: string; sessionTitle?: string; watchPaths?: string[]; systemMessage?: string }): HookOutput {
  const { systemMessage, ...specific } = fields;
  const output: HookOutput = {};
  const entries = Object.entries(specific).filter(([, value]) => value !== undefined);
  // Only these events accept hookSpecificOutput with these fields.
  if (entries.length && ["SessionStart", "FileChanged", "CwdChanged"].includes(event)) {
    const allowed = event === "SessionStart" ? ["additionalContext", "sessionTitle", "watchPaths"] : ["watchPaths"];
    const picked = Object.fromEntries(entries.filter(([name]) => allowed.includes(name)));
    if (Object.keys(picked).length) output.hookSpecificOutput = { hookEventName: event, ...picked };
  }
  if (systemMessage) output.systemMessage = systemMessage;
  return output;
}

/**
 * The gateway key Claude Code sends: ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY,
 * or, for teams on Claude subscriptions, the LiteLLM virtual key passed as
 * `x-litellm-api-key` in ANTHROPIC_CUSTOM_HEADERS
 * (https://docs.litellm.ai/docs/tutorials/claude_code_max_subscription).
 */
export function gatewayKeyFrom(env: Env): string | undefined {
  for (const line of (env.ANTHROPIC_CUSTOM_HEADERS ?? "").split("\n")) {
    const separator = line.indexOf(":");
    if (separator !== -1 && line.slice(0, separator).trim().toLowerCase() === "x-litellm-api-key") {
      const value = line.slice(separator + 1).trim().replace(/^Bearer\s+/i, "");
      if (value) return value;
    }
  }
  return env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || undefined;
}

function headerTicketTag(headers: string | undefined, contract: TicketContract): string | null {
  for (const line of (headers ?? "").split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1 || line.slice(0, separator).trim().toLowerCase() !== "x-litellm-tags") continue;
    for (const tag of line.slice(separator + 1).split(",")) {
      const key = keyFromTag(tag.trim(), contract);
      if (key) return key;
    }
  }
  return null;
}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

type State = { ticket: string | null; branch: string | null; root: string; registryUrl?: string; at: number; failed: boolean; reason: string };

/** Reports "no ticket" for a session last reported on one. Returns that ticket, if it did. */
async function leaveTicket(
  sessionId: string,
  env: Env,
  { report, stateDir, now }: Deps,
): Promise<{ ticket: string; ok: boolean; reason: string } | null> {
  const state = readState(stateDir, sessionId);
  const gatewayKey = gatewayKeyFrom(env);
  if (!state?.ticket || !state.registryUrl || !gatewayKey) return null;
  // After a failure, keep the ticket (so a later event retries) but don't retry more than once a minute.
  if (state.failed && now() - state.at < RETRY_FAILED_MS) return null;
  const result = await report({ session_id: sessionId, ticket: null, event: "left" }, { registryUrl: state.registryUrl, gatewayKey });
  if (result.ok) writeState(stateDir, sessionId, { ...state, ticket: null, branch: null, at: now(), failed: false, reason: "" });
  else writeState(stateDir, sessionId, { ...state, at: now(), failed: true, reason: result.reason });
  return { ticket: state.ticket, ok: result.ok, reason: result.ok ? "" : result.reason };
}

function readState(dir: string, sessionId: string): State | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, `${safe(sessionId)}.json`), "utf8"));
  } catch {
    return null;
  }
}

function writeState(dir: string, sessionId: string, state: State): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // "wx" after unlinking: never write through an existing symlink or file.
    const file = path.join(dir, `${safe(sessionId)}.json`);
    rmSync(file, { force: true });
    writeFileSync(file, JSON.stringify(state), { flag: "wx", mode: 0o600 });
  } catch {
    // State only avoids duplicate reports. Losing it costs one extra request.
  }
}

/**
 * Per-user state, never a shared temp directory: on a shared machine another
 * user could plant a symlink at a predictable /tmp path.
 */
function defaultStateDir(): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "tokens-per-ticket", "sessions");
}

/** Whether `root` is the project's repository, or a worktree of it. */
function sameRepo(root: string, projectDir: string | undefined): boolean {
  if (!projectDir) return true;
  const common = (dir: string) => git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir);
  const project = common(projectDir);
  return Boolean(project) && project === common(root);
}

/**
 * Keeps a copy of the CLI committed on the default branch in this repository's
 * git directory, for HOOK_COMMAND to run on a branch that has none (one from
 * before adoption), so the hook can still clear the ticket the session was on.
 * It comes from the default branch (origin/HEAD, else main), which the team
 * reviews, never from the checked-out branch, so a branch can't plant code
 * that later runs on other branches.
 */
function keepFallbackCopy(root: string): void {
  try {
    const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root);
    const ref = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], root) || (git(["rev-parse", "--verify", "--quiet", "refs/heads/main"], root) ? "main" : "");
    if (!commonDir || !ref) return;
    const committed = execFileSync("git", ["show", `${ref}:${BUNDLE_PATH}`], { cwd: root, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
    const copy = path.join(commonDir, FALLBACK_CLI);
    if (existsSync(copy) && readFileSync(copy).equals(committed)) return;
    writeFileSync(copy, committed);
  } catch {
    // No CLI on the default branch yet: without the copy, a pre-adoption branch keeps the last ticket.
  }
}

/** Drops session state older than 30 days. */
function pruneState(sessionsDir: string, now: () => number): void {
  try {
    for (const name of existsSync(sessionsDir) ? readdirSync(sessionsDir) : []) {
      const file = path.join(sessionsDir, name);
      if (now() - statSync(file).mtimeMs > 30 * 86_400_000) rmSync(file, { force: true });
    }
  } catch {
    // Best effort.
  }
}

function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}

/**
 * Claude Code settings entries for the hook, merged by `init`. Runs the
 * committed CLI at the checkout's root (the project dir may be a subfolder).
 * On a branch from before adoption, which has none, it runs the copy
 * keepFallbackCopy leaves in the git directory, so the ticket still clears.
 * Claude Code exports CLAUDE_PROJECT_DIR to hook processes.
 * https://code.claude.com/docs/en/hooks
 */
export const HOOK_COMMAND = `r="$(git -C "$CLAUDE_PROJECT_DIR" rev-parse --show-toplevel 2>/dev/null)" || r="$CLAUDE_PROJECT_DIR"; f="$r/${BUNDLE_PATH}"; [ -f "$f" ] || f="$(git -C "$CLAUDE_PROJECT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)/${FALLBACK_CLI}"; [ -f "$f" ] || exit 0; command -v node >/dev/null 2>&1 || exit 0; node "$f" hook`;

export function hookSettings(): Record<string, unknown[]> {
  const handler = { type: "command", command: HOOK_COMMAND };
  return {
    SessionStart: [{ hooks: [handler] }],
    UserPromptSubmit: [{ hooks: [handler] }],
    // No matcher: runs for the paths SessionStart returns in watchPaths (.git/HEAD).
    FileChanged: [{ hooks: [handler] }],
    CwdChanged: [{ hooks: [handler] }],
  };
}
