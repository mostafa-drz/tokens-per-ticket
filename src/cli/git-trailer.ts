import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findTicketKey, loadContract, type TicketContract } from "../lib/contract.ts";
import { BUNDLE_PATH } from "./hint.ts";

/**
 * Commit linkage: a git trailer such as "Ticket: ENG-123" on every commit made
 * on a ticket branch, added by a prepare-commit-msg hook. It works for any
 * commit (terminal, IDE, or Claude), and a PR's commits then say which ticket
 * they belong to. https://git-scm.com/docs/git-interpret-trailers
 */

const MARKER = "# tokens-per-ticket";

export const HOOK_SCRIPT = `#!/bin/sh
${MARKER}: adds a ticket trailer to commits on ticket branches.
root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -f "$root/${BUNDLE_PATH}" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0
node "$root/${BUNDLE_PATH}" git-trailer "$@" || true
`;

/** prepare-commit-msg <message-file> [source] [sha] */
export function runGitTrailer(argv: string[], cwd = process.cwd()): void {
  const [messageFile, source] = argv;
  // Merges and squashes carry their own messages; leave them alone.
  if (!messageFile || source === "merge" || source === "squash") return;

  const root = git(["rev-parse", "--show-toplevel"], cwd);
  if (!root) return;
  let contract: TicketContract;
  try {
    contract = loadContract(root);
  } catch {
    return;
  }
  const trailer = contract.automation.commit_trailer;
  const branch = git(["branch", "--show-current"], cwd);
  const ticket = branch ? findTicketKey(branch, contract) : null;
  if (!trailer || !ticket) return;

  git(["interpret-trailers", "--in-place", "--if-exists", "doNothing", "--trailer", `${trailer}: ${ticket}`, path.resolve(cwd, messageFile)], cwd);
}

export type HookInstall = "installed" | "present" | "foreign" | "disabled" | "no-repo";

/**
 * Installs the prepare-commit-msg hook where git looks for hooks (respecting
 * core.hooksPath). Never overwrites a hook someone else wrote.
 */
export function ensureCommitTrailerHook(root: string, contract: TicketContract): HookInstall {
  if (!contract.automation.commit_trailer) return "disabled";
  const hooksDir = git(["rev-parse", "--path-format=absolute", "--git-path", "hooks"], root);
  if (!hooksDir) return "no-repo";
  const file = path.join(hooksDir, "prepare-commit-msg");
  try {
    if (existsSync(file)) {
      const current = readFileSync(file, "utf8");
      if (!current.includes(MARKER)) return "foreign";
      if (current === HOOK_SCRIPT) return "present";
    }
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(file, HOOK_SCRIPT);
    chmodSync(file, 0o755);
    return "installed";
  } catch {
    return "no-repo";
  }
}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}
