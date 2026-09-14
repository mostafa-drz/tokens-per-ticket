import { z } from "zod";

/**
 * A thin client for the one LiteLLM endpoint this repo needs:
 * GET /tag/daily/activity, backed by the LiteLLM_DailyTagSpend table.
 *
 * Shapes mirror LiteLLM's SpendAnalyticsPaginatedResponse
 * (litellm/types/proxy/management_endpoints/common_daily_activity.py).
 * Unknown fields are ignored, so newer LiteLLM releases don't break parsing.
 */

const Metrics = z.object({
  spend: z.number().default(0),
  prompt_tokens: z.number().default(0),
  completion_tokens: z.number().default(0),
  cache_read_input_tokens: z.number().default(0),
  cache_creation_input_tokens: z.number().default(0),
  total_tokens: z.number().default(0),
  api_requests: z.number().default(0),
  successful_requests: z.number().default(0),
  failed_requests: z.number().default(0),
});

const MetricWithMetadata = z.object({ metrics: Metrics });

const DailySpend = z.object({
  date: z.string(),
  metrics: Metrics,
  breakdown: z
    .object({
      /** Keyed by the model name clients asked for, e.g. "claude-sonnet-5". */
      model_groups: z.record(z.string(), MetricWithMetadata).default({}),
      /** Keyed by the tag. */
      entities: z.record(z.string(), MetricWithMetadata).default({}),
    })
    .default({ model_groups: {}, entities: {} }),
});

const ActivityPage = z.object({
  results: z.array(DailySpend),
  metadata: z
    .object({
      page: z.number().default(1),
      has_more: z.boolean().default(false),
    })
    .default({ page: 1, has_more: false }),
});

export type SpendMetrics = z.infer<typeof Metrics>;
export type DailySpend = z.infer<typeof DailySpend>;

export type TagActivityQuery = {
  /** Exact tags, e.g. ["ticket:ENG-123"]. Omit for every tag. */
  tags?: string[];
  /** Inclusive, YYYY-MM-DD. LiteLLM requires both dates. */
  startDate: string;
  endDate: string;
};

export type LiteLLMConfig = {
  baseUrl: string;
  /** Needs access to spend routes. Server-side only, never shipped to a browser. */
  apiKey: string;
  fetch?: typeof fetch;
};

export class LiteLLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LiteLLMError";
  }
}

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/**
 * Fetches every page for the query. LiteLLM paginates over raw daily rows
 * (one per tag, day, key, model...), and each page comes back already grouped
 * by day. Summing across pages counts each row exactly once.
 */
export async function fetchTagActivity(
  query: TagActivityQuery,
  config: LiteLLMConfig,
): Promise<DailySpend[]> {
  const doFetch = config.fetch ?? fetch;
  const days: DailySpend[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL("/tag/daily/activity", config.baseUrl);
    url.searchParams.set("start_date", query.startDate);
    url.searchParams.set("end_date", query.endDate);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(PAGE_SIZE));
    if (query.tags?.length) url.searchParams.set("tags", query.tags.join(","));

    let response: Response;
    try {
      response = await doFetch(url, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        cache: "no-store",
      });
    } catch (cause) {
      throw new LiteLLMError(
        `Could not reach LiteLLM at ${config.baseUrl}. Is the gateway running? (${String(cause)})`,
      );
    }

    if (!response.ok) {
      const hint =
        response.status === 401 || response.status === 403
          ? " Check that the key can read spend routes (the master key or an admin key)."
          : "";
      throw new LiteLLMError(
        `LiteLLM returned ${response.status} for /tag/daily/activity.${hint}`,
        response.status,
      );
    }

    const parsed = ActivityPage.parse(await response.json());
    days.push(...parsed.results);
    if (!parsed.metadata.has_more) return mergeDays(days);
  }

  throw new LiteLLMError(`Stopped after ${MAX_PAGES} pages. Narrow the date range.`);
}

/**
 * Pages split raw rows, not days, so one date can appear on two pages.
 * Folds those back into one entry per date, newest first.
 */
export function mergeDays(days: DailySpend[]): DailySpend[] {
  const byDate = new Map<string, DailySpend>();
  for (const day of days) {
    const seen = byDate.get(day.date);
    byDate.set(
      day.date,
      seen
        ? {
            date: day.date,
            metrics: sumMetrics(seen.metrics, day.metrics),
            breakdown: {
              model_groups: mergeRecords(seen.breakdown.model_groups, day.breakdown.model_groups),
              entities: mergeRecords(seen.breakdown.entities, day.breakdown.entities),
            },
          }
        : day,
    );
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

function sumMetrics(a: SpendMetrics, b: SpendMetrics): SpendMetrics {
  const out = { ...a };
  for (const field of Object.keys(out) as (keyof SpendMetrics)[]) out[field] = a[field] + b[field];
  return out;
}

function mergeRecords(
  a: Record<string, { metrics: SpendMetrics }>,
  b: Record<string, { metrics: SpendMetrics }>,
): Record<string, { metrics: SpendMetrics }> {
  const out = { ...a };
  for (const [name, entry] of Object.entries(b)) {
    out[name] = out[name] ? { metrics: sumMetrics(out[name].metrics, entry.metrics) } : entry;
  }
  return out;
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The last `days` calendar days in UTC, today included. */
export function lastDays(days: number, now: Date = new Date()): { startDate: string; endDate: string } {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { startDate: isoDate(start), endDate: isoDate(now) };
}
