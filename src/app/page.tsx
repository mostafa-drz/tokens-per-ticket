import Link from "next/link";
import { Empty, Figure, Figures, RangePicker, SpendBar } from "@/app/_components/ledger-ui";
import { getTickets, parseRange } from "@/lib/data";
import { formatDay, formatPercent, formatTokens, formatUsd } from "@/lib/format";
import { addMetrics, cacheReadShare, emptyUsage } from "@/lib/ledger";

export default async function LedgerPage({ searchParams }: PageProps<"/">) {
  const days = parseRange((await searchParams).days);
  const { rows, range } = await getTickets(days);

  const total = rows.reduce(
    (sum, row) =>
      addMetrics(sum, {
        spend: row.spend,
        prompt_tokens: row.promptTokens,
        completion_tokens: row.completionTokens,
        cache_read_input_tokens: row.cacheReadTokens,
        cache_creation_input_tokens: row.cacheWriteTokens,
        total_tokens: row.totalTokens,
        api_requests: row.requests,
        successful_requests: row.requests - row.failedRequests,
        failed_requests: row.failedRequests,
      }),
    emptyUsage(),
  );
  const maxSpend = Math.max(0, ...rows.map((row) => row.spend));

  return (
    <main className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          What each ticket cost to build with AI
        </h1>
        <p className="max-w-2xl text-ink-soft">
          Every model call made while working a ticket carries its tag through the LiteLLM gateway. This is the sum,
          per ticket, for {formatDay(range.startDate)} to {formatDay(range.endDate)}.
        </p>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-ink-soft">
          {rows.length} {rows.length === 1 ? "ticket" : "tickets"}
        </h2>
        <RangePicker current={days} basePath="/" />
      </div>

      {rows.length === 0 ? (
        <Empty title="No ticket spend in this range">
          Start work with <code className="num">pnpm ticket:start ENG-123</code> so Claude Code tags its calls, or
          run <code className="num">pnpm gateway:smoke</code> to send a few tagged test calls.
        </Empty>
      ) : (
        <>
          <Figures>
            <Figure label="Spend" value={formatUsd(total.spend)} />
            <Figure label="Tokens" value={formatTokens(total.totalTokens)} />
            <Figure label="Cache reads" value={formatPercent(cacheReadShare(total))} note="of input tokens" />
            <Figure label="Requests" value={total.requests.toLocaleString("en-US")} />
          </Figures>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-rule text-left text-xs uppercase tracking-wider text-ink-soft">
                  <th scope="col" className="py-2 pr-4 font-medium">Ticket</th>
                  <th scope="col" className="w-40 py-2 pr-4 font-medium">Spend</th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">Tokens</th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">Cache reads</th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">Days</th>
                  <th scope="col" className="py-2 text-right font-medium">Last active</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="border-b border-rule hover:bg-sheet">
                    <td className="py-3 pr-4">
                      <Link href={`/tickets/${row.key}?days=${days}`} className="group flex flex-col">
                        <span className="num font-medium group-hover:text-money">{row.key}</span>
                        {row.title ? <span className="text-ink-soft">{row.title}</span> : null}
                      </Link>
                    </td>
                    <td className="py-3 pr-4">
                      <div className="flex flex-col gap-1.5">
                        <span className="num">{formatUsd(row.spend)}</span>
                        <SpendBar value={row.spend} max={maxSpend} label={`${formatUsd(row.spend)} of ${formatUsd(maxSpend)}`} />
                      </div>
                    </td>
                    <td className="num py-3 pr-4 text-right">{formatTokens(row.totalTokens)}</td>
                    <td className="num py-3 pr-4 text-right">{formatPercent(cacheReadShare(row))}</td>
                    <td className="num py-3 pr-4 text-right">{row.activeDays}</td>
                    <td className="num py-3 text-right text-ink-soft">{formatDay(row.lastDay)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
