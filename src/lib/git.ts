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

/** The main checkout's root, even when called from inside a linked worktree. */
export function mainCheckoutRoot(cwd?: string): string {
  const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  return path.dirname(commonDir);
}

export type Worktree = { path: string; branch: string | null };

export function listWorktrees(cwd?: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Worktree | null = null;
  for (const line of git(["worktree", "list", "--porcelain"], cwd).split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null };
      worktrees.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  return worktrees;
}

export function branchExists(branch: string, cwd?: string): boolean {
  return tryGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd) !== null;
}
