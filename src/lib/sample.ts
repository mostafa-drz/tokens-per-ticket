import { ticketTag, type TicketContract } from "./contract.ts";
import { CLAUDE_CODE_TAG } from "./ledger.ts";
import { isoDate, type DailySpend, type SpendMetrics, type TagActivityQuery } from "./litellm.ts";

/**
 * Sample data in LiteLLM's exact response shape, so the demo deploy runs the
 * same summarize code as a live gateway. Nothing here is real usage.
 *
 * The tickets are this repo's own backlog, as if it had been built one
 * ticket per session. Rates are illustrative, not current list prices.
 */

export const SAMPLE_TICKETS: { key: string; title: string; days: number; weight: number; cache: number }[] = [
  { key: "TPT-23", title: "Parse branches by template, not by key shape", days: 5, weight: 3.4, cache: 0.18 },
  { key: "TPT-12", title: "Ledger: ticket list page", days: 3, weight: 1.6, cache: 0.62 },
  { key: "TPT-15", title: "Post the report as one Linear comment", days: 2, weight: 1.1, cache: 0.55 },
  { key: "TPT-17", title: "Commit trailer on ticket branches", days: 4, weight: 1.9, cache: 0.47 },
  { key: "TPT-18", title: "SessionStart ticket guard hook", days: 1, weight: 0.5, cache: 0.71 },
  { key: "TPT-21", title: "Spend chart on the ticket page", days: 2, weight: 0.9, cache: 0.39 },
  { key: "TPT-9", title: "Local LiteLLM gateway with Postgres", days: 2, weight: 0.7, cache: 0.66 },
];

const MODELS = [
  { name: "claude-sonnet-5", share: 0.72, inRate: 3e-6, outRate: 15e-6 },
  { name: "claude-opus-5", share: 0.2, inRate: 15e-6, outRate: 75e-6 },
  { name: "claude-haiku-4-5", share: 0.08, inRate: 1e-6, outRate: 5e-6 },
];

export function sampleTitle(key: string): string | undefined {
  return SAMPLE_TICKETS.find((ticket) => ticket.key === key)?.title;
}

function random(seed: string): () => number {
  let state = [...seed].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 2166136261);
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function zero(): SpendMetrics {
  return {
    spend: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_tokens: 0,
    api_requests: 0,
    successful_requests: 0,
    failed_requests: 0,
  };
}

function add(a: SpendMetrics, b: SpendMetrics): SpendMetrics {
  const out = { ...a };
  for (const field of Object.keys(out) as (keyof SpendMetrics)[]) out[field] = a[field] + b[field];
  return out;
}

type Row = { date: string; tag: string; model: string; metrics: SpendMetrics };

function sampleRows(contract: TicketContract, now: Date): Row[] {
  const rows: Row[] = [];
  SAMPLE_TICKETS.forEach((ticket, index) => {
    const rand = random(ticket.key);
    const endOffset = 1 + index * 3;
    for (let d = 0; d < ticket.days; d++) {
      const date = new Date(now);
      date.setUTCDate(date.getUTCDate() - endOffset - (ticket.days - 1 - d) * (1 + Math.round(rand())));
      for (const model of MODELS) {
        const requests = Math.max(1, Math.round(ticket.weight * model.share * (40 + rand() * 60)));
        const prompt = Math.round(requests * (18_000 + rand() * 22_000));
        const cacheRead = Math.round(prompt * Math.min(0.9, ticket.cache * (0.8 + rand() * 0.4)));
        const cacheWrite = Math.round((prompt - cacheRead) * 0.25);
        const completion = Math.round(requests * (600 + rand() * 900));
        const failed = rand() > 0.85 ? 1 : 0;
        // Cache reads bill at a tenth of input, writes at 1.25x.
        const spend =
          (prompt - cacheRead - cacheWrite) * model.inRate +
          cacheRead * model.inRate * 0.1 +
          cacheWrite * model.inRate * 1.25 +
          completion * model.outRate;
        rows.push({
          date: isoDate(date),
          tag: ticketTag(ticket.key),
          model: model.name,
          metrics: {
            spend,
            prompt_tokens: prompt,
            completion_tokens: completion,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: cacheWrite,
            total_tokens: prompt + completion,
            api_requests: requests,
            successful_requests: requests - failed,
            failed_requests: failed,
          },
        });
      }
    }
  });
  // Every Claude Code call also carries LiteLLM's User-Agent tag, and some
  // work happened outside ticket branches (main, spikes): about 1 in 8 dollars.
  for (const row of [...rows]) rows.push({ ...row, tag: CLAUDE_CODE_TAG });
  const rand = random("unattributed");
  for (let d = 2; d < 40; d += 3) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - d);
    const prompt = Math.round(300_000 + rand() * 500_000);
    const completion = Math.round(prompt * 0.04);
    const requests = Math.round(prompt / 25_000);
    rows.push({
      date: isoDate(date),
      tag: CLAUDE_CODE_TAG,
      model: "claude-sonnet-5",
      metrics: {
        spend: prompt * 3e-6 + completion * 15e-6,
        prompt_tokens: prompt,
        completion_tokens: completion,
        cache_read_input_tokens: Math.round(prompt * 0.4),
        cache_creation_input_tokens: 0,
        total_tokens: prompt + completion,
        api_requests: requests,
        successful_requests: requests,
        failed_requests: 0,
      },
    });
  }
  return rows;
}

/** Answers a /tag/daily/activity query from sample rows. */
export function sampleTagActivity(query: TagActivityQuery, contract: TicketContract, now = new Date()): DailySpend[] {
  const wanted = query.tags?.length ? new Set(query.tags) : null;
  const byDate = new Map<string, DailySpend>();

  for (const row of sampleRows(contract, now)) {
    if (row.date < query.startDate || row.date > query.endDate) continue;
    if (wanted && !wanted.has(row.tag)) continue;
    const day = byDate.get(row.date) ?? { date: row.date, metrics: zero(), breakdown: { model_groups: {}, entities: {} } };
    day.metrics = add(day.metrics, row.metrics);
    const model = day.breakdown.model_groups[row.model]?.metrics ?? zero();
    day.breakdown.model_groups[row.model] = { metrics: add(model, row.metrics) };
    const entity = day.breakdown.entities[row.tag]?.metrics ?? zero();
    day.breakdown.entities[row.tag] = { metrics: add(entity, row.metrics) };
    byDate.set(row.date, day);
  }

  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}
