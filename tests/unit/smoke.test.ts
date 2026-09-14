import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyUsage, type TicketRow } from "../../src/lib/ledger.ts";
import { requestsByKey, smokeLanded } from "../../src/lib/smoke.ts";

const row = (key: string, requests: number): TicketRow => ({
  ...emptyUsage(),
  key,
  requests,
  firstDay: "2026-09-14",
  lastDay: "2026-09-14",
  activeDays: 1,
});

describe("gateway smoke check", () => {
  const sent = { "SMOKE-1": 3, "SMOKE-2": 1 };

  it("ignores other SMOKE-* tickets on a shared gateway", () => {
    const before = requestsByKey([], Object.keys(sent));
    const after = requestsByKey([row("SMOKE-1", 3), row("SMOKE-2", 1), row("SMOKE-3", 5)], Object.keys(sent));
    assert.equal(smokeLanded(before, after, sent), true);
  });

  it("doesn't pass on a re-run until this run's calls are written", () => {
    const keys = Object.keys(sent);
    const before = requestsByKey([row("SMOKE-1", 3), row("SMOKE-2", 1)], keys);
    assert.equal(smokeLanded(before, before, sent), false);
    assert.equal(smokeLanded(before, requestsByKey([row("SMOKE-1", 6), row("SMOKE-2", 1)], keys), sent), false);
    assert.equal(smokeLanded(before, requestsByKey([row("SMOKE-1", 6), row("SMOKE-2", 2)], keys), sent), true);
  });
});
