import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseContract } from "../../src/lib/contract.ts";
import { claudeArgs, shellCommand, ticketBranches } from "../../src/lib/launch.ts";
import type { TicketDetail } from "../../src/lib/ledger.ts";
import { upsertJiraReport } from "../../src/lib/jira.ts";
import { upsertLinearReport } from "../../src/lib/linear.ts";
import { reportPoster } from "../../src/lib/post.ts";
import { REPORT_SIGNATURE, renderReport } from "../../src/lib/report.ts";

describe("ticketBranches", () => {
  const jira = parseContract(`
key: { pattern: "[A-Z][A-Z0-9]*-[0-9]+" }
branch: { template: "feature/{KEY}_{slug}" }
worktree: { path: "../{repo}.worktrees/{branch}" }
`);

  it("finds a branch someone already made for the ticket, whatever its title", () => {
    const branches = ["main", "feature/PROJ-42_login", "feature/PROJ-420_other", "dependabot/npm_and_yarn/proj-42"];
    assert.deepEqual(ticketBranches(branches, "PROJ-42", jira), ["feature/PROJ-42_login"]);
    assert.deepEqual(ticketBranches(branches, "PROJ-7", jira), []);
  });
});

describe("claudeArgs", () => {
  it("only names the session: the branch and the gateway do the attribution", () => {
    assert.deepEqual(claudeArgs({ key: "ENG-1" }), ["--name", "ENG-1"]);
  });

  it("prints a command that survives a shell", () => {
    assert.equal(
      shellCommand("claude", ["--settings", `{"a":"it's"}`]),
      `claude --settings '{"a":"it'\\''s"}'`,
    );
  });
});

describe("renderReport", () => {
  const detail: TicketDetail = {
    key: "ENG-1",
    spend: 4.1,
    promptTokens: 1_100_000,
    completionTokens: 140_000,
    cacheReadTokens: 418_000,
    cacheWriteTokens: 50_000,
    totalTokens: 1_240_000,
    requests: 212,
    failedRequests: 3,
    firstDay: "2026-09-09",
    lastDay: "2026-09-14",
    activeDays: 4,
    days: [],
    models: [
      { model: "claude-sonnet-5", spend: 3.2, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_000_000, requests: 180, failedRequests: 0 },
    ],
  };

  const report = renderReport({
    detail,
    tag: "ticket:ENG-1",
    range: { startDate: "2026-08-16", endDate: "2026-09-14" },
    generatedAt: new Date("2026-09-14T18:30:00Z"),
  });

  it("leads with spend, tokens, cache share and days", () => {
    assert.match(report, /\| Spend \| \*\*\$4\.10\*\* \|/);
    assert.match(report, /1\.2M \(1\.1M in · 140K out\)/);
    assert.match(report, /38% of input tokens/);
    assert.match(report, /212 \(3 failed\)/);
    assert.match(report, /4 \(Sep 9 → Sep 14\)/);
    assert.match(report, /\| claude-sonnet-5 \| \$3\.20 \| 1M \| 180 \|/);
  });

  it("carries the signature used to update the Linear comment in place", () => {
    assert.ok(report.includes(REPORT_SIGNATURE));
    assert.match(report, /ticket:ENG-1/);
  });

  it("says nothing about the window when the ticket started inside it", () => {
    assert.doesNotMatch(report, /earlier spend may be missing/);
  });

  it("warns that the total may be partial when spend starts on the window's first day", () => {
    const partial = renderReport({
      detail: { ...detail, firstDay: "2026-08-16" },
      tag: "ticket:ENG-1",
      range: { startDate: "2026-08-16", endDate: "2026-09-14" },
      generatedAt: new Date("2026-09-14T18:30:00Z"),
    });
    assert.match(partial, /first day of this window, so earlier spend may be missing/);
    assert.match(partial, /--days/);
  });
});

describe("reportPoster", () => {
  it("picks the tracker from the contract and says which credentials are missing", () => {
    assert.match(reportPoster("linear", {}) as string, /LINEAR_API_KEY/);
    assert.match(reportPoster("jira", { JIRA_BASE_URL: "https://acme.atlassian.net" }) as string, /JIRA_EMAIL, JIRA_API_TOKEN/);
    assert.match(reportPoster("github", {}) as string, /linear or jira/);
    assert.equal(typeof reportPoster("Jira", { JIRA_BASE_URL: "https://x", JIRA_EMAIL: "a@b", JIRA_API_TOKEN: "t" }), "function");
  });
});

describe("upsertLinearReport", () => {
  it("pages through comments and updates only this key's own report comment", async () => {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const pages = [
      { nodes: [{ id: "c1", body: `quoted: ${REPORT_SIGNATURE}`, user: { id: "someone-else" } }], pageInfo: { hasNextPage: true, endCursor: "p2" } },
      { nodes: [{ id: "c2", body: `report ${REPORT_SIGNATURE}`, user: { id: "me" } }], pageInfo: { hasNextPage: false, endCursor: null } },
    ];
    const result = await upsertLinearReport(
      { key: "ENG-1", body: "new report" },
      {
        apiKey: "lin_api",
        fetch: async (_url, init) => {
          const request = JSON.parse(String(init?.body));
          calls.push(request);
          if (request.query.includes("TicketReportIssue")) {
            const comments = pages[request.variables.after ? 1 : 0];
            return Response.json({ data: { viewer: { id: "me" }, issue: { id: "i1", identifier: "ENG-1", url: "https://linear.app/x/ENG-1", comments } } });
          }
          return Response.json({ data: { commentUpdate: { success: true } } });
        },
      },
    );
    assert.equal(result.action, "updated");
    assert.deepEqual(calls.at(-1)?.variables, { id: "c2", input: { body: "new report" } });
  });
});

describe("upsertJiraReport", () => {
  it("adds a comment when this account has none, as an ADF code block", async () => {
    const requests: { method: string; url: string; body?: unknown }[] = [];
    const result = await upsertJiraReport(
      { key: "PROJ-42", body: `report ${REPORT_SIGNATURE}` },
      {
        baseUrl: "https://acme.atlassian.net",
        email: "lead@acme.dev",
        apiToken: "token",
        fetch: async (url, init) => {
          requests.push({ method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
          assert.equal((init?.headers as Record<string, string>).Authorization, `Basic ${Buffer.from("lead@acme.dev:token").toString("base64")}`);
          if (String(url).endsWith("/myself")) return Response.json({ accountId: "me" });
          if (String(url).includes("/comment?")) return Response.json({ comments: [{ id: "9", author: { accountId: "other" }, body: { text: REPORT_SIGNATURE } }], total: 1 });
          return Response.json({ id: "10" }, { status: 201 });
        },
      },
    );
    assert.equal(result.action, "created");
    assert.equal(result.url, "https://acme.atlassian.net/browse/PROJ-42");
    const post = requests.at(-1)!;
    assert.equal(post.method, "POST");
    assert.match(post.url, /\/rest\/api\/3\/issue\/PROJ-42\/comment$/);
    assert.deepEqual((post.body as { body: { content: { type: string }[] } }).body.content[0].type, "codeBlock");
  });
});
