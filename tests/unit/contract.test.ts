import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  branchName,
  findTicketKey,
  keyFromTag,
  loadContract,
  normalizeTicketKey,
  parseContract,
  ticketTag,
  worktreePath,
} from "../../src/lib/contract.ts";

const contract = loadContract();

describe("findTicketKey", () => {
  it("reads the key from Linear's default branch format", () => {
    assert.equal(findTicketKey("mostafa/eng-123-checkout-flow", contract), "ENG-123");
  });

  it("accepts an uppercase key and a missing slug", () => {
    assert.equal(findTicketKey("anibal/AIS-4525-route-claude-cli", contract), "AIS-4525");
    assert.equal(findTicketKey("mostafa/eng-7", contract), "ENG-7");
  });

  it("returns null for branches outside the contract", () => {
    assert.equal(findTicketKey("main", contract), null);
    assert.equal(findTicketKey("eng-7", contract), null);
    assert.equal(findTicketKey("dependabot/npm_and_yarn/next-16", contract), null);
    assert.equal(findTicketKey("spike/try-streaming", contract), null);
  });

  it("does not match a key glued to other characters", () => {
    assert.equal(findTicketKey("mostafa/eng-12a", contract), null);
    assert.equal(findTicketKey("mostafa/eng-12-", contract), null);
  });

  it("follows a different template when the team changes it", () => {
    const jira = parseContract(`
key: { pattern: "[A-Z][A-Z0-9]*-[0-9]+" }
branch: { template: "feature/{key}_{slug}" }
tag: { prefix: "ticket:" }
worktree: { path: "../{repo}.worktrees/{branch}" }
`);
    assert.equal(findTicketKey("feature/PROJ-42_login", jira), "PROJ-42");
    assert.equal(findTicketKey("mostafa/proj-42-login", jira), null);
  });

  it("respects the team allowlist", () => {
    const scoped = parseContract(`
key: { pattern: "[A-Z][A-Z0-9]*-[0-9]+", teams: [AIS] }
branch: { template: "{user}/{key}-{slug}" }
tag: { prefix: "ticket:" }
worktree: { path: "../{repo}.worktrees/{branch}" }
`);
    assert.equal(findTicketKey("mostafa/eng-123-x", scoped), null);
    assert.equal(findTicketKey("mostafa/ais-123-x", scoped), "AIS-123");
  });
});

describe("tags", () => {
  it("round-trips a ticket key through its spend tag", () => {
    const tag = ticketTag("ENG-123", contract);
    assert.equal(tag, "ticket:ENG-123");
    assert.equal(keyFromTag(tag, contract), "ENG-123");
  });

  it("ignores tags that are not ticket tags", () => {
    assert.equal(keyFromTag("User-Agent: claude-cli/2.1", contract), null);
    assert.equal(keyFromTag("app:ledger", contract), null);
  });
});

describe("naming", () => {
  it("normalizes user input", () => {
    assert.equal(normalizeTicketKey(" eng-42 ", contract), "ENG-42");
    assert.equal(normalizeTicketKey("not a key", contract), null);
  });

  it("builds a branch from the template", () => {
    assert.equal(
      branchName({ user: "Mostafa D", key: "ENG-123", slug: "Checkout flow: retries!" }, contract),
      "mostafa-d/eng-123-checkout-flow-retries",
    );
  });

  it("keeps the branch valid when the slug is empty", () => {
    assert.equal(branchName({ user: "mostafa", key: "ENG-9", slug: "" }, contract), "mostafa/eng-9");
  });

  it("drops the slug separator too when a custom template has no title", () => {
    const jira = parseContract(`
key: { pattern: "[A-Z][A-Z0-9]*-[0-9]+" }
branch: { template: "feature/{key}_{slug}" }
tag: { prefix: "ticket:" }
worktree: { path: "../{repo}.worktrees/{branch}" }
`);
    const branch = branchName({ user: "mostafa", key: "PROJ-43", slug: "" }, jira);
    assert.equal(branch, "feature/proj-43");
    assert.equal(findTicketKey(branch, jira), "PROJ-43");
    assert.equal(branchName({ user: "mostafa", key: "PROJ-43", slug: "Login page" }, jira), "feature/proj-43_login-page");
  });

  it("keeps the key as printed with {KEY}, for trackers such as Jira", () => {
    const jira = parseContract(`
key: { pattern: "[A-Z][A-Z0-9]*-[0-9]+" }
branch: { template: "feature/{KEY}_{slug}" }
tag: { prefix: "ticket:" }
worktree: { path: "../{repo}.worktrees/{branch}" }
`);
    const branch = branchName({ user: "mostafa", key: "PROJ-42", slug: "Short title" }, jira);
    assert.equal(branch, "feature/PROJ-42_short-title");
    assert.equal(findTicketKey(branch, jira), "PROJ-42");
    assert.equal(findTicketKey("feature/proj-42_typed-by-hand", jira), "PROJ-42");
    assert.equal(
      worktreePath({ repoRoot: "/work/app", branch }, jira),
      "/work/app.worktrees/feature__PROJ-42_short-title",
    );
  });

  it("rejects a template without a key placeholder", () => {
    assert.throws(() =>
      parseContract(`
key: { pattern: "[A-Z]+-[0-9]+" }
branch: { template: "feature/{slug}" }
tag: { prefix: "ticket:" }
worktree: { path: "../{repo}.worktrees/{branch}" }
`),
    );
  });

  it("places worktrees next to the repo, one folder per branch", () => {
    assert.equal(
      worktreePath({ repoRoot: "/work/tokens-per-ticket", branch: "mostafa/eng-9" }, contract),
      "/work/tokens-per-ticket.worktrees/mostafa__eng-9",
    );
  });
});

describe("automation settings", () => {
  const base = `
key: { pattern: "[A-Z][A-Z0-9]*-[0-9]+" }
branch: { template: "{user}/{key}-{slug}" }
tag: { prefix: "ticket:" }
worktree: { path: "../{repo}.worktrees/{branch}" }
`;

  it("turns session tracking and the commit trailer on when the section is missing", () => {
    const contract = parseContract(base);
    assert.equal(contract.automation.sessions, true);
    assert.equal(contract.automation.commit_trailer, "Ticket");
    assert.equal(contract.automation.registry_url, undefined);
  });

  it("reads the repo's automation section", () => {
    assert.deepEqual(loadContract().automation, {
      sessions: true,
      registry_url: "http://localhost:4100",
      commit_trailer: "Ticket",
    });
  });

  it("rejects a trailer name git would not accept", () => {
    assert.throws(() => parseContract(`${base}\nautomation: { commit_trailer: "Ticket id" }`));
    assert.equal(parseContract(`${base}\nautomation: { commit_trailer: false }`).automation.commit_trailer, false);
  });
});
