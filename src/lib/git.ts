import { execFileSync } from "node:child_process";
import path from "node:path";

export function git(args: string[], cwd: string = process.cwd()): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function tryGit(args: string[], cwd?: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

export function currentBranch(cwd?: string): string | null {
  const branch = tryGit(["branch", "--show-current"], cwd);
  return branch || null;
}

/** The main checkout's root, even from inside a linked worktree. Null outside a repository. */
export function mainCheckoutRoot(cwd?: string): string | null {
  const commonDir = tryGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  return commonDir ? path.dirname(commonDir) : null;
}
