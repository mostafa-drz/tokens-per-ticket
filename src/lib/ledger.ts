import { keyFromTag, type TicketContract } from "./contract.ts";
import type { DailySpend, SpendMetrics } from "./litellm.ts";

/**
 * Turns LiteLLM's daily tag activity into per-ticket numbers.
 *
 * Two shapes, because LiteLLM breaks spend down differently depending on the
 * query:
 * - All tags: each day lists `breakdown.entities` (tag -> metrics). Good for
 *   the ticket list. It has no per-model split per tag.
 * - One tag: the day's `metrics` and `breakdown.model_groups` belong to that tag
 *   alone. Good for a ticket's detail and its report.
 *
 * Never sum a day's top-level metrics across several tags: a request tagged
 * with two tags is counted once per tag.
 */

export type Usage = {
  spend: number;
  promptTokens: number;
  completionTokens: number;
  /** Included in promptTokens. LiteLLM folds cache reads and writes into prompt tokens. */
  cacheReadTokens: number;
  /** Included in promptTokens. */
  cacheWriteTokens: number;
  totalTokens: number;
  requests: number;
  failedRequests: number;
};

export type TicketRow = Usage & {
  key: string;
  firstDay: string;
  lastDay: string;
  activeDays: number;
};

export type TicketDetail = TicketRow & {
  models: (Usage & { model: string })[];
  days: (Usage & { date: string })[];
};

export function emptyUsage(): Usage {
  return {
    spend: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    requests: 0,
    failedRequests: 0,
  };
}

export function addMetrics(usage: Usage, metrics: SpendMetrics): Usage {
  return {
    spend: usage.spend + metrics.spend,
    promptTokens: usage.promptTokens + metrics.prompt_tokens,
    completionTokens: usage.completionTokens + metrics.completion_tokens,
    cacheReadTokens: usage.cacheReadTokens + metrics.cache_read_input_tokens,
    cacheWriteTokens: usage.cacheWriteTokens + metrics.cache_creation_input_tokens,
    totalTokens: usage.totalTokens + metrics.total_tokens,
    requests: usage.requests + metrics.api_requests,
    failedRequests: usage.failedRequests + metrics.failed_requests,
  };
}

/** Share of prompt tokens served from the prompt cache, 0..1. */
export function cacheReadShare(usage: Usage): number {
  return usage.promptTokens === 0 ? 0 : usage.cacheReadTokens / usage.promptTokens;
}

/** Every ticket that spent anything in the range, most expensive first. */
export function summarizeTickets(days: DailySpend[], contract: TicketContract): TicketRow[] {
  const rows = new Map<string, TicketRow>();

  for (const day of days) {
    for (const [tag, entity] of Object.entries(day.breakdown.entities)) {
      const key = keyFromTag(tag, contract);
      if (!key) continue;
      const current = rows.get(key) ?? {
        ...emptyUsage(),
        key,
        firstDay: day.date,
        lastDay: day.date,
        activeDays: 0,
      };
      rows.set(key, {
        ...current,
        ...addMetrics(current, entity.metrics),
        firstDay: day.date < current.firstDay ? day.date : current.firstDay,
        lastDay: day.date > current.lastDay ? day.date : current.lastDay,
        activeDays: current.activeDays + 1,
      });
    }
  }

  return [...rows.values()].sort((a, b) => b.spend - a.spend || a.key.localeCompare(b.key));
}

/**
 * One ticket, from a query filtered to that ticket's tag.
 * Returns null when the ticket has no recorded spend in the range.
 */
export function summarizeTicket(key: string, days: DailySpend[]): TicketDetail | null {
  const active = days
    .filter((day) => day.metrics.api_requests > 0 || day.metrics.spend > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (active.length === 0) return null;

  const models = new Map<string, Usage>();
  let total = emptyUsage();
  const dayRows: TicketDetail["days"] = [];

  for (const day of active) {
    total = addMetrics(total, day.metrics);
    dayRows.push({ date: day.date, ...addMetrics(emptyUsage(), day.metrics) });
    for (const [model, entry] of Object.entries(day.breakdown.model_groups)) {
      models.set(model, addMetrics(models.get(model) ?? emptyUsage(), entry.metrics));
    }
  }

  return {
    key,
    ...total,
    firstDay: active[0].date,
    lastDay: active[active.length - 1].date,
    activeDays: active.length,
    days: dayRows,
    models: [...models.entries()]
      .map(([model, usage]) => ({ model, ...usage }))
      .sort((a, b) => b.spend - a.spend),
  };
}
