import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  if (!root || !existsSync(path.join(root, CONTRACT_FILE))) {
    // Not a repo that adopted tokens-per-ticket (or not a repo at all). A
    // session that moved here from a ticket must stop counting toward it.
    if (event === "CwdChanged" && input.session_id) {
      const left = await leaveTicket(input.session_id, env, { report, stateDir, now });
      if (left) return withEvent(event, { systemMessage: `tokens-per-ticket: this directory isn't set up for tokens-per-ticket, so the session no longer counts toward ${left}.` });
    }
    return event === "SessionStart" || event === "CwdChanged" ? withEvent(event, {}) : {};
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
      if (event !== "UserPromptSubmit" || changed || due) {
        const payload: SessionReport = {
          session_id: input.session_id,
          ticket,
          branch,
          repo: repoName(root),
          event,
        };
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
      if (reported === "failed") problems.push(`Couldn't report this session to the registry: ${failure.replace(/\.$/, "")}. Its spend isn't attributed until that works.`);
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

  if (event === "FileChanged") {
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

/** A stable, non-sensitive repo name: the origin remote without credentials, or the folder name. */
function repoName(root: string): string {
  const remote = git(["config", "--get", "remote.origin.url"], root);
  if (!remote) return path.basename(root);
  return remote.replace(/^[a-z+]+:\/\/[^@/]*@/i, "").replace(/\.git$/, "");
}

type State = { ticket: string | null; branch: string | null; root: string; registryUrl?: string; at: number; failed: boolean; reason: string };

/** Reports "no ticket" for a session last reported on one. Returns that ticket, if it did. */
async function leaveTicket(sessionId: string, env: Env, { report, stateDir, now }: Deps): Promise<string | null> {
  const state = readState(stateDir, sessionId);
  const gatewayKey = gatewayKeyFrom(env);
  if (!state?.ticket || !state.registryUrl || !gatewayKey) return null;
  const result = await report(
    { session_id: sessionId, ticket: null, branch: null, repo: null, event: "CwdChanged" },
    { registryUrl: state.registryUrl, gatewayKey },
  );
  writeState(stateDir, sessionId, { ...state, ticket: null, branch: null, at: now(), failed: !result.ok, reason: result.ok ? "" : result.reason });
  return state.ticket;
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

function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}

/**
 * Claude Code settings entries for the hook, merged by `init`. Claude Code
 * exports CLAUDE_PROJECT_DIR to hook processes.
 * https://code.claude.com/docs/en/hooks
 */
export const HOOK_COMMAND = `node "$CLAUDE_PROJECT_DIR/${BUNDLE_PATH}" hook`;

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
