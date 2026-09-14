import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "../../src/proxy.ts";
import type { TicketDetail } from "../../src/lib/ledger.ts";
import { reviewPrompt } from "../../src/lib/review.ts";

describe("proxy (LEDGER_BASIC_AUTH)", () => {
  afterEach(() => {
    delete process.env.LEDGER_BASIC_AUTH;
  });

  const request = (authorization?: string) =>
    new NextRequest("http://ledger.test/", { headers: authorization ? { authorization } : {} });

  it("lets everything through when no password is configured", () => {
    assert.notEqual(proxy(request()).status, 401);
  });

  it("asks for credentials when a password is configured", () => {
    process.env.LEDGER_BASIC_AUTH = "lead:s3cret";
    const response = proxy(request());
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /Basic/);
  });

  it("accepts the right credentials and rejects the wrong ones", () => {
    process.env.LEDGER_BASIC_AUTH = "lead:s3cret";
    assert.notEqual(proxy(request(`Basic ${btoa("lead:s3cret")}`)).status, 401);
    assert.equal(proxy(request(`Basic ${btoa("lead:guess")}`)).status, 401);
  });
});

describe("reviewPrompt", () => {
  it("gives the model the numbers the review guidelines talk about", () => {
    const detail: TicketDetail & { title: string } = {
      key: "TPT-23",
      title: "Parse branches by template",
      spend: 169,
      promptTokens: 28_900_000,
      completionTokens: 1_100_000,
      cacheReadTokens: 5_200_000,
      cacheWriteTokens: 0,
      totalTokens: 30_000_000,
      requests: 1025,
      failedRequests: 2,
      firstDay: "2026-09-05",
      lastDay: "2026-09-13",
      activeDays: 4,
      days: [],
      models: [{ model: "claude-opus-5", spend: 100.87, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 6_500_000, requests: 231, failedRequests: 0 }],
    };
    const prompt = reviewPrompt(detail);
    assert.match(prompt, /Ticket TPT-23: Parse branches by template/);
    assert.match(prompt, /Prompt cache reads: 18% of input tokens/);
    assert.match(prompt, /Requests: 1025, failed: 2/);
    assert.match(prompt, /claude-opus-5: \$100\.87/);
  });
});
