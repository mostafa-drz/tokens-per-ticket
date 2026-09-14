import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/**
 * The ticket contract: branch name -> ticket key -> spend tag.
 *
 * Kept free of Next.js imports so the CLI scripts, the Claude Code hook,
 * and the app all share one implementation.
 */

const ContractSchema = z.object({
  tracker: z.string().default("linear"),
  key: z.object({
    pattern: z.string().min(1),
    teams: z.array(z.string()).default([]),
  }),
  branch: z.object({
    template: z.string().includes("{key}"),
  }),
  tag: z.object({
    prefix: z.string().min(1),
  }),
  worktree: z.object({
    path: z.string().min(1),
  }),
});

export type TicketContract = z.infer<typeof ContractSchema>;

export const CONTRACT_FILE = "ticket-contract.yaml";

export function parseContract(source: string): TicketContract {
  return ContractSchema.parse(parse(source));
}

export function loadContract(root: string = process.cwd()): TicketContract {
  return parseContract(readFileSync(path.join(root, CONTRACT_FILE), "utf8"));
}

/** Normalizes user input like "eng-123" to "ENG-123", or returns null. */
export function normalizeTicketKey(input: string, contract: TicketContract): string | null {
  const candidate = input.trim().toUpperCase();
  const whole = new RegExp(`^(?:${contract.key.pattern})$`);
  if (!whole.test(candidate)) return null;
  return isAllowedTeam(candidate, contract) ? candidate : null;
}

/**
 * Reads the ticket key from a branch that follows the branch template.
 *
 * Matching is strict on purpose: searching for "anything that looks like a
 * key" misreads branches such as `dependabot/npm_and_yarn/next-16` as ticket
 * NEXT-16. Branch names lowercase the key, so the key part is matched
 * case-insensitively. The slug is optional. Returns null for branches outside
 * the contract (main, spikes, bots).
 */
export function findTicketKey(branch: string, contract: TicketContract): string | null {
  const match = branchPattern(contract).exec(branch);
  return match ? normalizeTicketKey(match[1], contract) : null;
}

function branchPattern(contract: TicketContract): RegExp {
  const source = contract.branch.template
    .split(/(\{user\}|\{key\}|[-_./]?\{slug\})/)
    .map((part) => {
      if (part === "{user}") return "[^/]+";
      if (part === "{key}") return `(${contract.key.pattern})`;
      if (part.endsWith("{slug}")) return `(?:${escapeRegExp(part.slice(0, -"{slug}".length))}.+)?`;
      return escapeRegExp(part);
    })
    .join("");
  return new RegExp(`^${source}$`, "i");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function ticketTag(key: string, contract: TicketContract): string {
  return `${contract.tag.prefix}${key}`;
}

/** Reverse of ticketTag. Returns null for tags that aren't ticket tags. */
export function keyFromTag(tag: string, contract: TicketContract): string | null {
  if (!tag.startsWith(contract.tag.prefix)) return null;
  return normalizeTicketKey(tag.slice(contract.tag.prefix.length), contract);
}

export function slugify(text: string, maxLength = 40): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

export function branchName(
  input: { user: string; key: string; slug: string },
  contract: TicketContract,
): string {
  return contract.branch.template
    .replaceAll("{user}", slugify(input.user))
    .replaceAll("{key}", input.key.toLowerCase())
    .replaceAll("{slug}", slugify(input.slug))
    .replace(/-+$/g, "");
}

export function worktreePath(
  input: { repoRoot: string; branch: string },
  contract: TicketContract,
): string {
  const relative = contract.worktree.path
    .replaceAll("{repo}", path.basename(input.repoRoot))
    .replaceAll("{branch}", input.branch.replaceAll("/", "__"));
  return path.resolve(input.repoRoot, relative);
}

function isAllowedTeam(key: string, contract: TicketContract): boolean {
  if (contract.key.teams.length === 0) return true;
  const team = key.slice(0, key.lastIndexOf("-"));
  return contract.key.teams.map((t) => t.toUpperCase()).includes(team);
}
