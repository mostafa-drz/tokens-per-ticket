import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findTicketKey, loadContract, type TicketContract } from "../lib/contract.ts";
import { BUNDLE_PATH } from "./hint.ts";

/**
 * Commit linkage: a git trailer such as "Ticket: ENG-123" on every commit made
 * on a ticket branch, added by a prepare-commit-msg hook. It works for any
 * commit (terminal, IDE, or Claude), and a PR's commits then say which ticket
 * they belong to. https://git-scm.com/docs/git-interpret-trailers
 *
 * Neither the git hook nor the Claude Code hooks run the checkout's
 * .tokens-per-ticket/tpt.mjs once set up: that file changes with whatever
 * branch is checked out. They run a copy kept in the git directory instead.
 * The copy is created the first time a hook runs in a clone (from the branch
 * that clone started on) and replaced only by an explicit `tpt init`.
 */

const MARKER = "# tokens-per-ticket";
const TRUSTED_CLI = "tokens-per-ticket/tpt.mjs";

export const HOOK_SCRIPT = `#!/bin/sh
${MARKER}: adds a ticket trailer to commits on ticket branches.
# Runs the copy in the git directory, not the checkout's file, so checking out
# a branch can't change the code that runs when you commit.
dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || exit 0
cli="$dir/${TRUSTED_CLI}"
[ -f "$cli" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0
node "$cli" git-trailer "$@" || true
`;

/** Where the git hook's copy of the CLI lives, shared by all worktrees. */
export function trustedCliPath(root: string): string | null {
  const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root);
  return commonDir ? path.join(commonDir, TRUSTED_CLI) : null;
}

export type TrustedCliState = "updated" | "current" | "differs" | "missing";

/**
 * Copies the checkout's CLI into the git directory.
 *
 * `replace: true` is for `tpt init`, an explicit choice to use this
 * checkout's CLI. Hooks call it with `replace: false`: they only create the
 * copy when there is none yet, and report "differs" when a branch carries a
 * different CLI, without running or copying it.
 */
export function refreshTrustedCli(root: string, { replace }: { replace: boolean }): TrustedCliState {
  const source = path.join(root, BUNDLE_PATH);
  const target = trustedCliPath(root);
  if (!target || !existsSync(source)) return "missing";
  try {
    if (existsSync(target)) {
      if (readFileSync(target).equals(readFileSync(source))) return "current";
      if (!replace) return "differs";
    }
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
    return "updated";
  } catch {
    return "missing";
  }
}

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
