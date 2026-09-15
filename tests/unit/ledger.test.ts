import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { loadContract } from "../../src/lib/contract.ts";
import { cacheReadShare, claudeCodeUsage, summarizeTicket, summarizeTickets } from "../../src/lib/ledger.ts";
import { fetchTagActivity, lastDays, LiteLLMError, mergeDays, PAGE_SIZE, type DailySpend } from "../../src/lib/litellm.ts";

const contract = loadContract();

// Both fixtures were recorded from a real LiteLLM v1.100.1 gateway
// (gateway/docker-compose.yml) after tagged calls to the mock model.
function fixture(name: string) {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

async function parsedFixture(name: string): Promise<DailySpend[]> {
  const body = fixture(name);
  return fetchTagActivity(
    { startDate: "2026-09-14", endDate: "2026-09-14" },
    { baseUrl: "http://gateway.test", apiKey: "sk-test", fetch: async () => Response.json(body) },
  );
}

describe("summarizeTickets (all tags)", () => {
  it("keeps ticket tags and drops LiteLLM's automatic User-Agent tags", async () => {
    const rows = summarizeTickets(await parsedFixture("litellm-tag-activity.all-tags.json"), contract);
    assert.deepEqual(
      rows.map((row) => row.key),
      ["TPT-3", "TPT-1", "TPT-2"],
    );
  });

  it("does not double count a request that carries several tags", async () => {
    const days = await parsedFixture("litellm-tag-activity.all-tags.json");
    const tpt3 = summarizeTickets(days, contract).find((row) => row.key === "TPT-3");
    // The same single request is also tagged "User-Agent: curl" and
    // "User-Agent: curl/8.7.1", so the day's top-level spend is 3x this.
    assert.equal(tpt3?.requests, 1);
    assert.equal(tpt3?.promptTokens, 10);
    assert.equal(tpt3?.completionTokens, 20);
    assert.ok(Math.abs((tpt3?.spend ?? 0) - 0.00033) < 1e-9);
    assert.ok(days[0].metrics.spend > (tpt3?.spend ?? 0) * 2);
  });
});

describe("summarizeTicket (one tag)", () => {
  it("reports totals and the model split for one ticket", async () => {
    const detail = summarizeTicket("TPT-3", await parsedFixture("litellm-tag-activity.one-tag.json"));
    assert.ok(detail);
    assert.equal(detail.requests, 1);
    assert.equal(detail.totalTokens, 30);
    assert.deepEqual(
      detail.models.map((m) => m.model),
      ["mock-ticket-model"],
    );
    assert.equal(detail.firstDay, "2026-09-14");
  });

  it("returns null when nothing was spent", () => {
    assert.equal(summarizeTicket("TPT-404", []), null);
  });
});

describe("fetchTagActivity", () => {
  it("follows pages and merges a date split across them", async () => {
    const page = (date: string, spend: number, hasMore: boolean) => ({
      results: [{ date, metrics: { spend, api_requests: 1 }, breakdown: { entities: { "ticket:TPT-1": { metrics: { spend, api_requests: 1 } } } } }],
      metadata: { has_more: hasMore },
    });
    const pages = [page("2026-09-14", 1, true), page("2026-09-14", 2, true), page("2026-09-13", 4, false)];
    const seen: string[] = [];

    const days = await fetchTagActivity(
      { tags: ["ticket:TPT-1"], startDate: "2026-09-13", endDate: "2026-09-14" },
      {
        baseUrl: "http://gateway.test",
        apiKey: "sk-test",
        fetch: async (url) => {
          seen.push(String(url));
          return Response.json(pages[seen.length - 1]);
        },
      },
    );

    assert.equal(seen.length, 3);
    assert.match(seen[0], /tags=ticket%3ATPT-1/);
    // Large pages: a busy org's month of rows must fit in MAX_PAGES requests.
    assert.equal(new URL(seen[0]).searchParams.get("page_size"), String(PAGE_SIZE));
    assert.ok(PAGE_SIZE >= 1000);
    assert.deepEqual(
      days.map((d) => [d.date, d.metrics.spend]),
      [
        ["2026-09-14", 3],
        ["2026-09-13", 4],
      ],
    );
    const [row] = summarizeTickets(days, contract);
    assert.equal(row.activeDays, 2);
    assert.equal(row.spend, 7);
  });

  it("explains auth failures", async () => {
    await assert.rejects(
      fetchTagActivity(
        { startDate: "2026-09-14", endDate: "2026-09-14" },
        { baseUrl: "http://gateway.test", apiKey: "bad", fetch: async () => new Response("no", { status: 401 }) },
      ),
      (error: unknown) => error instanceof LiteLLMError && /spend routes/.test(error.message),
    );
  });

  it("explains an unreachable gateway", async () => {
    await assert.rejects(
      fetchTagActivity(
        { startDate: "2026-09-14", endDate: "2026-09-14" },
        {
          baseUrl: "http://gateway.test",
          apiKey: "sk-test",
          fetch: async () => {
            throw new TypeError("fetch failed");
          },
        },
      ),
      /Is the gateway running/,
    );
  });
});

describe("claudeCodeUsage", () => {
  it("sums LiteLLM's Claude Code User-Agent tag, not the versioned variants", () => {
    const metrics = (spend: number) => ({ metrics: { spend, prompt_tokens: 0, completion_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_tokens: 0, api_requests: 1, successful_requests: 1, failed_requests: 0 } });
    const day = (date: string, spend: number) => ({
      date,
      metrics: metrics(spend * 3).metrics,
      breakdown: { model_groups: {}, entities: { "User-Agent: claude-cli": metrics(spend), "User-Agent: claude-cli/2.1.270 (external, cli)": metrics(spend), "ticket:TPT-1": metrics(spend / 2) } },
    });
    assert.equal(claudeCodeUsage([day("2026-09-14", 4), day("2026-09-13", 2)]).spend, 6);
  });
});

describe("helpers", () => {
  it("computes the cache read share of prompt tokens", () => {
    const usage = { spend: 0, promptTokens: 200, completionTokens: 0, cacheReadTokens: 150, cacheWriteTokens: 0, totalTokens: 200, requests: 1, failedRequests: 0 };
    assert.equal(cacheReadShare(usage), 0.75);
    assert.equal(cacheReadShare({ ...usage, promptTokens: 0 }), 0);
  });

  it("builds an inclusive UTC date range", () => {
    assert.deepEqual(lastDays(7, new Date("2026-09-14T23:00:00Z")), { startDate: "2026-09-08", endDate: "2026-09-14" });
  });

  it("merges nothing when days are already unique", () => {
    assert.deepEqual(mergeDays([]), []);
  });
});
