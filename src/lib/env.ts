import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Loads `.env.local` for the CLI scripts.
 *
 * `.env.local` is gitignored, so a worktree made by `pnpm ticket:start` never
 * has one. The scripts are meant to run inside those worktrees (the
 * /ticket-cost skill does exactly that), so after the current checkout's file
 * they also read the main checkout's.
 *
 * process.loadEnvFile never overrides a variable that is already set, so the
 * shell wins, then the first file that sets a variable.
 * https://nodejs.org/api/process.html#processloadenvfilepath
 */
export function loadEnvLocal(roots: string[], file = ".env.local"): string[] {
  const loaded: string[] = [];
  for (const root of new Set(roots.map((r) => path.resolve(r)))) {
    const candidate = path.join(root, file);
    if (!existsSync(candidate)) continue;
    process.loadEnvFile(candidate);
    loaded.push(candidate);
  }
  return loaded;
}
