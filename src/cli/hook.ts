import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export async function handleHook(input: HookInput, env: Env = process.env, deps: Partial<Deps> = {}): Promise<HookOutput> {
  const { report, stateDir, now } = {
    report: reportSession,
    stateDir: path.join(os.tmpdir(), "tokens-per-ticket", "sessions"),
    now: Date.now,
    ...deps,
  };
  const event = input.hook_event_name ?? "unknown";
  const cwd = input.new_cwd ?? input.cwd ?? process.cwd();

  const root = git(["rev-parse", "--show-toplevel"], cwd);
  if (!root || !existsSync(path.join(root, CONTRACT_FILE))) {
    // Not a repo that adopted tokens-per-ticket (or not a repo at all).
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
  const explicit = explicitTicket(env.ANTHROPIC_CUSTOM_HEADERS, contract);

  const startEvent = event === "SessionStart" || event === "CwdChanged";
  if (startEvent) ensureCommitTrailerHook(root, contract);

  const title = event === "SessionStart" && ticket && !input.session_title && input.source !== "clear" && input.source !== "compact" ? ticket : undefined;

  // Where calls go and who makes them. Without both, the registry can't help.
  const problems: string[] = [];
  if (!env.ANTHROPIC_BASE_URL) problems.push("Claude Code isn't pointed at the LiteLLM gateway (ANTHROPIC_BASE_URL is not set), so no spend from this session reaches it.");

  const registryUrl = env.TPT_REGISTRY_URL || contract.automation.registry_url;
  const gatewayKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
  const automatic = contract.automation.sessions && registryUrl;

  let reported: "sent" | "skipped" | "failed" = "skipped";
  let failure = "";
  if (automatic && env.ANTHROPIC_BASE_URL && input.session_id) {
    if (!gatewayKey) {
      problems.push("No gateway key in ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY, so this session can't be reported to the registry.");
    } else {
      const state = readState(stateDir, input.session_id);
      const changed = !state || state.ticket !== ticket || state.branch !== branch || state.root !== root;
      const due = !state || now() - state.at > REPORT_EVERY_MS || state.failed;
      if (event !== "UserPromptSubmit" || changed || due) {
        const payload: SessionReport = {
          session_id: input.session_id,
          ticket,
          branch,
          repo: repoName(root),
          head: git(["rev-parse", "HEAD"], cwd) || null,
          event,
        };
        const result = await report(payload, { registryUrl, gatewayKey });
        reported = result.ok ? "sent" : "failed";
        if (!result.ok) failure = result.reason;
        const alreadyWarned = state?.failed && state.reason === failure;
        writeState(stateDir, input.session_id, { ticket, branch, root, at: now(), failed: !result.ok, reason: failure });
        if (!result.ok && alreadyWarned && event === "UserPromptSubmit") return {};
      }
      if (reported === "failed") problems.push(`Couldn't report this session to the registry: ${failure}. Its spend isn't attributed until that works.`);
    }
  }

  if (explicit && ticket && explicit !== ticket) {
    problems.push(`This session was started with ticket ${explicit}, which the gateway keeps even though the branch is ${ticket}. Start a new session to follow the branch.`);
  }

  const billedTo = explicit ?? (automatic ? ticket : null);
  const context = billedTo
    ? `tokens-per-ticket: model calls in this session count toward ticket ${billedTo}${explicit ? "" : ", following the current branch automatically"}.`
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

function explicitTicket(headers: string | undefined, contract: TicketContract): string | null {
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

type State = { ticket: string | null; branch: string | null; root: string; at: number; failed: boolean; reason: string };

function readState(dir: string, sessionId: string): State | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, `${safe(sessionId)}.json`), "utf8"));
  } catch {
    return null;
  }
}

function writeState(dir: string, sessionId: string, state: State): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${safe(sessionId)}.json`), JSON.stringify(state));
  } catch {
    // State only avoids duplicate reports. Losing it costs one extra request.
  }
}

function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}

/** Claude Code settings entries for the hook, merged by `init`. */
export function hookSettings(): Record<string, unknown[]> {
  const handler = { type: "command", command: "node", args: [`\${CLAUDE_PROJECT_DIR}/${BUNDLE_PATH}`, "hook"] };
  return {
    SessionStart: [{ hooks: [handler] }],
    UserPromptSubmit: [{ hooks: [handler] }],
    // No matcher: runs for the paths SessionStart returns in watchPaths (.git/HEAD).
    FileChanged: [{ hooks: [handler] }],
    CwdChanged: [{ hooks: [handler] }],
  };
}
