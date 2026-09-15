import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findTicketKey,
  keyFromTag,
  loadContract,
  normalizeTicketKey,
  parseContract,
  ticketTag,
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
`);
    assert.equal(findTicketKey("feature/PROJ-42_login", jira), "PROJ-42");
    assert.equal(findTicketKey("mostafa/proj-42-login", jira), null);
  });

  it("respects the team allowlist", () => {
    const scoped = parseContract(`
key: { pattern: "[A-Z][A-Z0-9]*-[0-9]+", teams: [AIS] }
branch: { template: "{user}/{key}-{slug}" }
`);
    assert.equal(findTicketKey("mostafa/eng-123-x", scoped), null);
    assert.equal(findTicketKey("mostafa/ais-123-x", scoped), "AIS-123");
  });
});

describe("tags", () => {
  it("round-trips a ticket key through its spend tag", () => {
    const tag = ticketTag("ENG-123");
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

  it("reads the key back with {KEY}, as trackers such as Jira print it, and typed by hand", () => {
    const jira = parseContract(`
key: { pattern: "[A-Z][A-Z0-9]*-[0-9]+" }
branch: { template: "feature/{KEY}_{slug}" }
`);
    assert.equal(findTicketKey("feature/PROJ-42_short-title", jira), "PROJ-42");
    assert.equal(findTicketKey("feature/proj-42_typed-by-hand", jira), "PROJ-42");
  });

  it("rejects a template without a key placeholder", () => {
    assert.throws(() =>
      parseContract(`
key: { pattern: "[A-Z]+-[0-9]+" }
branch: { template: "feature/{slug}" }
`),
    );
  });
});

describe("automation settings", () => {
  const base = `
key: { pattern: "[A-Z][A-Z0-9]*-[0-9]+" }
branch: { template: "{user}/{key}-{slug}" }
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
    assert.equal(parseContract(`${base}\nautomation: { ledger_url: "https://tokens.acme.dev" }`).automation.ledger_url, "https://tokens.acme.dev");
  });

  it("names the field when the file is wrong", () => {
    assert.throws(() => parseContract(`${base}\nautomation: { registry_url: "not a url" }`), /automation.registry_url must be a URL/);
    assert.throws(() => parseContract(`branch: { template: "{key}" }`), /key must be a section/);
  });

  it("rejects a trailer name git would not accept", () => {
    assert.throws(() => parseContract(`${base}\nautomation: { commit_trailer: "Ticket id" }`));
    assert.equal(parseContract(`${base}\nautomation: { commit_trailer: false }`).automation.commit_trailer, false);
  });
});
