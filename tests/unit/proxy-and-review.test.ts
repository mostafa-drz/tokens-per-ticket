import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "../../src/proxy.ts";
import { basicAuthOk } from "../../src/lib/basic-auth.ts";
import type { TicketDetail } from "../../src/lib/ledger.ts";
import { reviewApiKey, reviewModel, reviewPrompt } from "../../src/lib/review.ts";

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

  it("answers a malformed header with 401, not a server error", () => {
    process.env.LEDGER_BASIC_AUTH = "lead:s3cret";
    assert.equal(proxy(request("Basic %%%not-base64")).status, 401);
  });
});

describe("basicAuthOk (re-checked in data access and the review action)", () => {
  it("passes when no password is configured", () => {
    assert.equal(basicAuthOk(null, undefined), true);
    assert.equal(basicAuthOk(null, ""), true);
  });

  it("requires the exact credentials when a password is configured", () => {
    assert.equal(basicAuthOk(null, "lead:s3cret"), false);
    assert.equal(basicAuthOk(`Basic ${btoa("lead:s3cret")}`, "lead:s3cret"), true);
    assert.equal(basicAuthOk(`Basic ${btoa("lead:s3cre")}`, "lead:s3cret"), false);
    assert.equal(basicAuthOk(`Bearer ${btoa("lead:s3cret")}`, "lead:s3cret"), false);
    assert.equal(basicAuthOk("Basic %%%", "lead:s3cret"), false);
  });
});

describe("reviewModel", () => {
  it("is off without LEDGER_REVIEW_MODEL", () => {
    assert.equal(reviewModel({ NODE_ENV: "development" }), null);
  });

  it("stays off in production without LEDGER_BASIC_AUTH, so a public deploy can't spend tokens", () => {
    assert.equal(reviewModel({ NODE_ENV: "production", LEDGER_REVIEW_MODEL: "claude-haiku-4-5" }), null);
    assert.equal(
      reviewModel({ NODE_ENV: "production", LEDGER_REVIEW_MODEL: "claude-haiku-4-5", LEDGER_BASIC_AUTH: "lead:pw" }),
      "claude-haiku-4-5",
    );
    assert.equal(reviewModel({ NODE_ENV: "development", LEDGER_REVIEW_MODEL: " claude-haiku-4-5 " }), "claude-haiku-4-5");
  });
});

describe("reviewApiKey", () => {
  it("prefers the budgeted review key over the spend-reading key", () => {
    assert.equal(reviewApiKey({ NODE_ENV: "production", LEDGER_REVIEW_API_KEY: "sk-review", LITELLM_API_KEY: "sk-reader" }), "sk-review");
    assert.equal(reviewApiKey({ NODE_ENV: "development", LITELLM_API_KEY: "sk-reader" }), "sk-reader");
    assert.equal(reviewApiKey({ NODE_ENV: "development", LEDGER_REVIEW_API_KEY: " " }), null);
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
