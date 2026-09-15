import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONTRACT_FILE, findTicketKey, keyFromTag, loadContract, type TicketContract } from "../lib/contract.ts";
import { keyFingerprint, reportSession, trustedRegistryUrl, type SessionReport } from "../lib/registry-client.ts";
import { ensureCommitTrailerHook, refreshTrustedCli } from "./git-trailer.ts";
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
  /** Set when the hook fires inside a subagent. */
  agent_id?: string;
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
    stateDir: defaultStateDir(),
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

  // Inside a subagent, report for that subagent only: its worktree or `cd`
  // must not move the main conversation's ticket or rename the session.
  const agentId = input.agent_id || undefined;
  const startEvent = event === "SessionStart" || event === "CwdChanged";
  let cliNotice: string | undefined;
  if (startEvent) {
    // Create the trusted copy the hooks run, only if this clone has none yet.
    // A branch with a different CLI is reported, never copied or run.
    if (refreshTrustedCli(root, { replace: false }) === "differs" && event === "SessionStart") {
      cliNotice = `This checkout carries a different ${BUNDLE_PATH} than the copy the hooks run (in .git). The hooks keep using that copy. After reviewing the change, run \`node ${BUNDLE_PATH} init\` to switch to it.`;
    }
    ensureCommitTrailerHook(root, contract);
  }

  const title = !agentId && event === "SessionStart" && ticket && !input.session_title && input.source !== "clear" && input.source !== "compact" ? ticket : undefined;

  // Where calls go and who makes them. Without both, the registry can't help.
  const problems: string[] = cliNotice ? [cliNotice] : [];
  if (!env.ANTHROPIC_BASE_URL) problems.push("Claude Code isn't pointed at the LiteLLM gateway (ANTHROPIC_BASE_URL is not set), so no spend from this session reaches it.");

  const registry = trustedRegistryUrl({
    envUrl: env.TPT_REGISTRY_URL,
    repoUrl: contract.automation.registry_url,
    gatewayUrl: env.ANTHROPIC_BASE_URL,
  });
  const registryUrl = registry.url;
  const gatewayKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
  const automatic = contract.automation.sessions && registryUrl;
  if (contract.automation.sessions && registry.ignored && env.ANTHROPIC_BASE_URL) {
    problems.push(
      `automation.registry_url (${registry.ignored}) isn't on the gateway's host, so it's ignored. Set TPT_REGISTRY_URL in your Claude Code settings to use it.`,
    );
  }

  let reported: "sent" | "skipped" | "failed" = "skipped";
  let failure = "";
  if (automatic && env.ANTHROPIC_BASE_URL && input.session_id) {
    if (!gatewayKey) {
      problems.push("No gateway key in ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY, so this session can't be reported to the registry.");
    } else {
      const stateId = agentId ? `${input.session_id}.${agentId}` : input.session_id;
      const state = readState(stateDir, stateId);
      const changed = !state || state.ticket !== ticket || state.branch !== branch || state.root !== root;
      const due = !state || now() - state.at > REPORT_EVERY_MS || state.failed;
      if (event !== "UserPromptSubmit" || changed || due) {
        const payload: SessionReport = {
          session_id: input.session_id,
          ...(agentId ? { agent_id: agentId } : {}),
          key_fingerprint: keyFingerprint(gatewayKey),
          ticket,
          branch,
          repo: repoName(root),
          head: git(["rev-parse", "HEAD"], cwd) || null,
          event,
        };
        const result = await report(payload, { registryUrl });
        reported = result.ok ? "sent" : "failed";
        if (!result.ok) failure = result.reason;
        const alreadyWarned = state?.failed && state.reason === failure;
        writeState(stateDir, stateId, { ticket, branch, root, at: now(), failed: !result.ok, reason: failure });
        if (!result.ok && alreadyWarned && event === "UserPromptSubmit") return {};
      }
      if (reported === "failed") problems.push(`Couldn't report this session to the registry: ${failure}. Its spend isn't attributed until that works.`);
    }
  }

  // With the registry on, the gateway refuses requests that carry their own
  // ticket tag, so a leftover header would break every call in the session.
  if (automatic && explicit) {
    problems.push(`ANTHROPIC_CUSTOM_HEADERS sets ticket ${explicit}, but the gateway sets tickets itself and will refuse these calls. Remove the ticket entry from x-litellm-tags.`);
  }
  // Without it, an explicit tag from \`tpt start\` counts.
  if (!automatic && explicit && ticket && explicit !== ticket) {
    problems.push(`This session was started with ticket ${explicit}, which the gateway keeps even though the branch is ${ticket}. Start a new session to follow the branch.`);
  }

  const billedTo = automatic ? ticket : explicit;
  const context = billedTo
    ? `tokens-per-ticket: model calls in this session count toward ticket ${billedTo}${automatic ? ", following the current branch automatically" : ""}.`
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
 * Claude Code settings entries for the hook, merged by `init`.
 *
 * The command runs the CLI copy in the git directory, so a branch that swaps
 * .tokens-per-ticket/tpt.mjs doesn't change what runs. It falls back to the
 * checkout's file only in a clone that has no copy yet, and that first run
 * creates the copy. Shell form, because it chooses between two paths; Claude
 * Code exports CLAUDE_PROJECT_DIR to hook processes in both forms.
 * https://code.claude.com/docs/en/hooks
 */
export const HOOK_COMMAND = `c="$(git -C "$CLAUDE_PROJECT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)/tokens-per-ticket/tpt.mjs"; [ -f "$c" ] || c="$CLAUDE_PROJECT_DIR/${BUNDLE_PATH}"; node "$c" hook`;

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
