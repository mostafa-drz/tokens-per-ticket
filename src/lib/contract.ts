import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/**
 * The ticket contract (tokens-per-ticket.yaml): branch name -> ticket key ->
 * spend tag, plus how much of it runs automatically.
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
    // {key} writes the key lowercased (Linear's default), {KEY} as the tracker
    // prints it. Jira only links branches whose key is uppercase:
    // https://support.atlassian.com/jira-software-cloud/docs/reference-issues-in-your-development-work/
    template: z
      .string()
      .refine((template) => template.includes("{key}") || template.includes("{KEY}"), {
        message: "branch.template must contain {key} or {KEY}",
      }),
  }),
  worktree: z.object({
    path: z.string().min(1),
  }),
  // Automatic attribution: Claude Code hooks report which ticket each session
  // is on, and the gateway tags every call. No command for engineers to run.
  automation: z
    .object({
      sessions: z.boolean().default(true),
      // The session registry that runs next to LiteLLM. TPT_REGISTRY_URL overrides it.
      registry_url: z.string().url().optional(),
      // Git trailer added to commits on ticket branches, or false for none.
      commit_trailer: z.union([z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/), z.literal(false)]).default("Ticket"),
      // Where engineers read spend. `tpt report` and /ticket-cost point here when
      // the machine has no spend-reading key (which belongs in CI, not on laptops).
      ledger_url: z.string().url().optional(),
    })
    .prefault({}),
});

export type TicketContract = z.infer<typeof ContractSchema>;

export const CONTRACT_FILE = "tokens-per-ticket.yaml";

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
 * NEXT-16. Templates may lowercase the key ({key}) or keep it ({KEY}), and
 * people type branches by hand, so the key part is matched case-insensitively. The slug is optional. Returns null for branches outside
 * the contract (main, spikes, bots).
 */
export function findTicketKey(branch: string, contract: TicketContract): string | null {
  const match = branchPattern(contract).exec(branch);
  return match ? normalizeTicketKey(match[1], contract) : null;
}

/** The optional slug and the one separator character in front of it. */
const SLUG_WITH_SEPARATOR = /[-_./]?\{slug\}/g;

function branchPattern(contract: TicketContract): RegExp {
  const source = contract.branch.template
    .split(/(\{user\}|\{key\}|\{KEY\}|[-_./]?\{slug\})/)
    .map((part) => {
      if (part === "{user}") return "[^/]+";
      if (part === "{key}" || part === "{KEY}") return `(${contract.key.pattern})`;
      if (part.endsWith("{slug}")) return `(?:${escapeRegExp(part.slice(0, -"{slug}".length))}.+)?`;
      return escapeRegExp(part);
    })
    .join("");
  return new RegExp(`^${source}$`, "i");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Fixed, not configurable: the gateway plugin sets and refuses tags with this
 * prefix, and two settings for one value would drift.
 */
export const TAG_PREFIX = "ticket:";

export function ticketTag(key: string): string {
  return `${TAG_PREFIX}${key}`;
}

/** Reverse of ticketTag. Returns null for tags that aren't ticket tags. */
export function keyFromTag(tag: string, contract: TicketContract): string | null {
  if (!tag.startsWith(TAG_PREFIX)) return null;
  return normalizeTicketKey(tag.slice(TAG_PREFIX.length), contract);
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
  const slug = slugify(input.slug);
  return (
    contract.branch.template
      // Without a title, drop the slug together with its separator, whatever
      // it is ("-", "_", ".", "/"). Leaving "feature/proj-42_" behind would
      // create a branch that findTicketKey can't read back.
      .replace(SLUG_WITH_SEPARATOR, (part) => (slug ? part.replace("{slug}", slug) : ""))
      .replaceAll("{user}", slugify(input.user))
      .replaceAll("{key}", input.key.toLowerCase())
      .replaceAll("{KEY}", input.key)
  );
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
