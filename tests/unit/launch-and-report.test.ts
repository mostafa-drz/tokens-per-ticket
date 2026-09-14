import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeArgs, shellCommand, withTicketTag } from "../../src/lib/launch.ts";
import type { TicketDetail } from "../../src/lib/ledger.ts";
import { REPORT_SIGNATURE, renderReport } from "../../src/lib/report.ts";

describe("withTicketTag", () => {
  it("creates the tags header when there are no custom headers", () => {
    assert.equal(withTicketTag(undefined, "ticket:ENG-1", "ticket:"), "x-litellm-tags: ticket:ENG-1");
  });

  it("keeps other headers and other tags, and replaces an older ticket tag", () => {
    const existing = "x-team: platform\nX-LiteLLM-Tags: team:platform, ticket:ENG-0";
    assert.equal(
      withTicketTag(existing, "ticket:ENG-1", "ticket:"),
      "x-team: platform\nx-litellm-tags: team:platform,ticket:ENG-1",
    );
  });
});

describe("claudeArgs", () => {
  it("passes the header through --settings and names the session after the ticket", () => {
    const args = claudeArgs({ key: "ENG-1", headers: "x-litellm-tags: ticket:ENG-1" });
    assert.equal(args[0], "--settings");
    assert.deepEqual(JSON.parse(args[1]), { env: { ANTHROPIC_CUSTOM_HEADERS: "x-litellm-tags: ticket:ENG-1" } });
    assert.deepEqual(args.slice(2), ["--name", "ENG-1"]);
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
});
