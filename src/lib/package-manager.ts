import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The commands the CLI and the hook suggest, in the package manager of the
 * repository they were copied into. A product repo on npm should not be told
 * to run `pnpm install`, and needs `--` before script flags.
 */

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const LOCKFILES: [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

/**
 * Reads package.json's `packageManager` field (Corepack's convention), then
 * the lockfile, then the user agent of the package manager running the
 * script. Falls back to npm, which ships with Node.
 * https://github.com/nodejs/corepack#readme
 */
export function detectPackageManager(root: string, env: Record<string, string | undefined> = process.env): PackageManager {
  try {
    const field = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))?.packageManager;
    const name = typeof field === "string" ? field.split("@")[0] : "";
    if (isPackageManager(name)) return name;
  } catch {
    // No or unreadable package.json: keep looking.
  }
  for (const [file, manager] of LOCKFILES) {
    if (existsSync(path.join(root, file))) return manager;
  }
  const agent = env.npm_config_user_agent?.split("/")[0] ?? "";
  return isPackageManager(agent) ? agent : "npm";
}

function isPackageManager(name: string): name is PackageManager {
  return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun";
}

/**
 * `npm run <script> -- <args>`: npm reads flags before `--` as its own
 * config, so `npm run ticket:start ENG-1 --print` never passes --print.
 * https://docs.npmjs.com/cli/v11/commands/npm-run
 */
export function scriptCommand(manager: PackageManager, script: string, args: string[] = []): string {
  const rest = args.length ? ` ${args.join(" ")}` : "";
  if (manager === "npm") return `npm run ${script}${args.length ? ` --${rest}` : ""}`;
  if (manager === "bun") return `bun run ${script}${rest}`;
  return `${manager} ${script}${rest}`;
}

export function installCommand(manager: PackageManager): string {
  return `${manager} install`;
}

/**
 * Flags npm swallowed because they came before `--`. npm keeps an unknown
 * flag as config and exposes it to the script as `npm_config_<name>`, so the
 * script can tell the difference instead of silently ignoring it.
 */
export function flagsTakenByNpm(flags: string[], env: Record<string, string | undefined> = process.env): string[] {
  if (!env.npm_config_user_agent?.startsWith("npm/")) return [];
  return flags.filter((flag) => env[`npm_config_${flag}`] !== undefined);
}
