import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

/**
 * The ticket contract (tokens-per-ticket.yaml): branch name -> ticket key ->
 * spend tag, plus how much of it runs automatically.
 *
 * Kept free of Next.js imports so the CLI scripts, the Claude Code hook,
 * and the app all share one implementation.
 */

export type TicketContract = {
  tracker: string;
  key: { pattern: string; teams: string[] };
  /**
   * {key} writes the key lowercased (Linear's default), {KEY} as the tracker
   * prints it. Jira only links branches whose key is uppercase:
   * https://support.atlassian.com/jira-software-cloud/docs/reference-issues-in-your-development-work/
   */
  branch: { template: string };
  /**
   * Automatic attribution: Claude Code hooks report which ticket each session
   * is on, and the gateway tags every call.
   */
  automation: {
    sessions: boolean;
    /** The session registry that runs next to LiteLLM. TPT_REGISTRY_URL overrides it. */
    registry_url?: string;
    /** Git trailer added to commits on ticket branches, or false for none. */
    commit_trailer: string | false;
    /** Where engineers read spend when the machine has no spend-reading key. */
    ledger_url?: string;
  };
};

export const CONTRACT_FILE = "tokens-per-ticket.yaml";

export function parseContract(source: string): TicketContract {
  const data = parse(source);
  const root = record(data, "the file");
  const key = record(root.key, "key");
  const branch = record(root.branch, "branch");
  const automation = root.automation === undefined || root.automation === null ? {} : record(root.automation, "automation");

  const template = text(branch.template, "branch.template");
  if (!template.includes("{key}") && !template.includes("{KEY}")) invalid("branch.template must contain {key} or {KEY}");
  const trailer = automation.commit_trailer ?? "Ticket";
  if (trailer !== false && (typeof trailer !== "string" || !/^[A-Za-z][A-Za-z0-9-]*$/.test(trailer))) {
    invalid("automation.commit_trailer must be a trailer name such as Ticket, or false");
  }
  const teams = key.teams ?? [];
  if (!Array.isArray(teams) || teams.some((team) => typeof team !== "string")) invalid("key.teams must be a list of team keys");

  return {
    tracker: root.tracker === undefined ? "linear" : text(root.tracker, "tracker"),
    key: { pattern: text(key.pattern, "key.pattern"), teams },
    branch: { template },
    automation: {
      sessions: automation.sessions === undefined ? true : bool(automation.sessions, "automation.sessions"),
      commit_trailer: trailer as string | false,
      // Only present when set, like the file.
      ...optionalUrl(automation.registry_url, "registry_url"),
      ...optionalUrl(automation.ledger_url, "ledger_url"),
    },
  };
}

function invalid(message: string): never {
  throw new Error(`${CONTRACT_FILE}: ${message}`);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be a section`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") invalid(`${name} must be a non-empty string`);
  return value;
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") invalid(`${name} must be true or false`);
  return value;
}

function optionalUrl(value: unknown, name: "registry_url" | "ledger_url"): Partial<Record<typeof name, string>> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "string" || !URL.canParse(value)) invalid(`automation.${name} must be a URL`);
  return { [name]: value };
}

export function loadContract(root: string = process.cwd()): TicketContract {
  return parseContract(readFileSync(path.join(root, CONTRACT_FILE), "utf8"));
}

/**
 * The contract from the first of these checkouts that has one: the current
 * checkout, then the main one. During rollout the main checkout may still be
 * on a branch from before adoption. Null when none has it.
 */
export function loadFirstContract(roots: (string | null | undefined)[]): TicketContract | null {
  const root = roots.find((dir): dir is string => Boolean(dir) && existsSync(path.join(dir!, CONTRACT_FILE)));
  return root ? loadContract(root) : null;
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

function isAllowedTeam(key: string, contract: TicketContract): boolean {
  if (contract.key.teams.length === 0) return true;
  const team = key.slice(0, key.lastIndexOf("-"));
  return contract.key.teams.map((t) => t.toUpperCase()).includes(team);
}
