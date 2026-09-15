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

/**
 * LiteLLM pages over raw LiteLLM_DailyTagSpend rows: one per (date, tag, key,
 * model, provider, endpoint...), and the all-tags query also returns every
 * User-Agent tag row. `page_size` has no upper bound in get_tag_daily_activity
 * (v1.100.1, tag_management_endpoints.py), and there is no aggregated tag
 * endpoint, so the client fetches one day at a time: a day is one page even
 * for a few hundred engineers, days load in parallel, and finished days are
 * cached per server instance.
 */
export const PAGE_SIZE = 10_000;
const PAGES_PER_DAY = 20;
const PARALLEL_DAYS = 6;

/**
 * Days that can no longer change. LiteLLM writes spend in batches, so the day
 * before today (UTC) can still grow for a while after midnight.
 */
const closedDays = new Map<string, DailySpend | null>();
const CLOSED_DAYS_LIMIT = 5_000;

/**
 * Fetches spend for every day in the query, newest first. Summing the pages of
 * one day counts each raw row once.
 */
export async function fetchTagActivity(
  query: TagActivityQuery,
  config: LiteLLMConfig,
  now: Date = new Date(),
): Promise<DailySpend[]> {
  const dates = datesBetween(query.startDate, query.endDate);
  const lastChanging = isoDate(new Date(now.getTime() - 86_400_000));
  const days: (DailySpend | null)[] = new Array(dates.length);

  let next = 0;
  async function worker() {
    while (next < dates.length) {
      const index = next++;
      const date = dates[index];
      const cacheKey = `${config.baseUrl}|${query.tags?.join(",") ?? "*"}|${date}`;
      if (closedDays.has(cacheKey)) {
        days[index] = closedDays.get(cacheKey)!;
        continue;
      }
      days[index] = await fetchDay(date, query.tags, config);
      if (date < lastChanging && !config.fetch) {
        if (closedDays.size >= CLOSED_DAYS_LIMIT) closedDays.clear();
        closedDays.set(cacheKey, days[index]);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL_DAYS, dates.length) }, worker));
  return mergeDays(days.filter((day): day is DailySpend => day !== null));
}

/**
 * One day, all pages. Pages are offsets over rows ordered by (date, id), so a
 * row inserted between two page requests could shift the offsets. Pages are
 * large enough that a day is almost always a single request.
 */
async function fetchDay(date: string, tags: string[] | undefined, config: LiteLLMConfig): Promise<DailySpend | null> {
  const results: DailySpend[] = [];
  for (let page = 1; ; page++) {
    if (page > PAGES_PER_DAY) throw new LiteLLMError(`${date} has more than ${PAGES_PER_DAY * PAGE_SIZE} spend rows.`);
    const parsed = await fetchPage(date, page, tags, config);
    results.push(...parsed.results);
    if (!parsed.metadata.has_more) return mergeDays(results)[0] ?? null;
  }
}

async function fetchPage(date: string, page: number, tags: string[] | undefined, config: LiteLLMConfig) {
  const url = new URL("/tag/daily/activity", config.baseUrl);
  url.searchParams.set("start_date", date);
  url.searchParams.set("end_date", date);
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(PAGE_SIZE));
  if (tags?.length) url.searchParams.set("tags", tags.join(","));

  let response: Response;
  try {
    response = await (config.fetch ?? fetch)(url, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      cache: "no-store",
    });
  } catch (cause) {
    throw new LiteLLMError(`Could not reach LiteLLM at ${config.baseUrl}. Is the gateway running? (${String(cause)})`);
  }

  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? " Use a key that can read spend routes, such as a proxy_admin_viewer key."
        : "";
    throw new LiteLLMError(`LiteLLM returned ${response.status} for /tag/daily/activity.${hint}`, response.status);
  }
  return ActivityPage.parse(await response.json());
}

/** Every date from start to end, inclusive, newest first. */
export function datesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let day = new Date(`${endDate}T00:00:00Z`); isoDate(day) >= startDate; day.setUTCDate(day.getUTCDate() - 1)) {
    dates.push(isoDate(day));
    if (dates.length > 366) throw new LiteLLMError("Ask for a year or less at a time.");
  }
  return dates;
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
