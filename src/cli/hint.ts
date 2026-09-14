import { scriptCommand, type PackageManager } from "../lib/package-manager.ts";

/** Where the bundled CLI lives in a repo that adopted tokens-per-ticket. */
export const BUNDLE_PATH = ".tokens-per-ticket/tpt.mjs";

const SUBCOMMANDS: Record<string, string> = { "ticket:start": "start", "ticket:report": "report" };

/**
 * The command to suggest to a user. From the bundle (a product repo) that's
 * `node .tokens-per-ticket/tpt.mjs <sub>`, which works with any package
 * manager or none. From this repo's pnpm scripts it's the script form.
 */
export function command(manager: PackageManager, script: string, args: string[] = [], argv1 = process.argv[1] ?? ""): string {
  if (argv1.endsWith("tpt.mjs")) {
    return ["node", BUNDLE_PATH, SUBCOMMANDS[script] ?? script, ...args].join(" ");
  }
  return scriptCommand(manager, script, args);
}
