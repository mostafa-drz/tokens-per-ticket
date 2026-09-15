/**
 * tpt ticket [--branch <name>]
 *
 * Prints the ticket key and spend tag for a branch, from the contract. The
 * /ticket-cost skill uses it so an agent never has to guess how this team's
 * branches name tickets. Exits 1 when the branch names no ticket.
 */
import { parseArgs } from "node:util";
import { CONTRACT_FILE, findTicketKey, loadFirstContract, ticketTag } from "../lib/contract.ts";
import { currentBranch, mainCheckoutRoot, tryGit } from "../lib/git.ts";

export async function runTicket(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { branch: { type: "string" }, help: { type: "boolean", short: "h", default: false } } });
  if (values.help) {
    console.log("Usage: node <path-to>/tpt.mjs ticket [--branch <name>]\n\n  Prints: <KEY> <tag>");
    return;
  }

  const here = tryGit(["rev-parse", "--show-toplevel"]) ?? process.cwd();
  const contract = loadFirstContract([here, mainCheckoutRoot()]);
  if (!contract) fail(`No ${CONTRACT_FILE} here. Run this inside a repository that has adopted tokens-per-ticket.`);

  const branch = values.branch ?? currentBranch();
  const key = branch ? findTicketKey(branch, contract) : null;
  if (!key) fail(`Branch "${branch ?? "(detached)"}" doesn't name a ticket under ${CONTRACT_FILE}.`);

  console.log(`${key} ${ticketTag(key)}`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
