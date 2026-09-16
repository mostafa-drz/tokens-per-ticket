/** Where the bundled CLI lives in a repo that adopted tokens-per-ticket. */
export const BUNDLE_PATH = ".tokens-per-ticket/tpt.mjs";

/** The command to suggest: the bundle works with any package manager, or none. */
export function command(subcommand: string, args: string[] = []): string {
  return ["node", BUNDLE_PATH, subcommand, ...args].join(" ");
}
