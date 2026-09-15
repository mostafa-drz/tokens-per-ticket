import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Empty, Figure, Figures, RangePicker, SpendBar } from "@/app/_components/ledger-ui";
import { loadContract, normalizeTicketKey } from "@/lib/contract";
import { getTicket, parseRange } from "@/lib/data";
import { formatDay, formatPercent, formatTokens, formatUsd } from "@/lib/format";
import { cacheReadShare } from "@/lib/ledger";
import { renderReport } from "@/lib/report";
import { DailySpendChart } from "./daily-spend-chart";

export async function generateMetadata({ params }: PageProps<"/tickets/[key]">): Promise<Metadata> {
  return { title: (await params).key.toUpperCase() };
}

export default async function TicketPage({ params, searchParams }: PageProps<"/tickets/[key]">) {
  const key = normalizeTicketKey((await params).key, loadContract(process.cwd()));
  if (!key) notFound();

  const days = parseRange((await searchParams).days);
  const { detail, tag, range } = await getTicket(key, days);

  return (
    <main className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Link href={`/?days=${days}`} className="text-sm text-ink-soft hover:text-ink">
          ← All tickets
        </Link>
        <h1 className="flex flex-col gap-1">
          <span className="num text-3xl font-semibold tracking-tight sm:text-4xl">{key}</span>
          {detail?.title ? <span className="text-xl text-ink-soft text-balance">{detail.title}</span> : null}
        </h1>
        <p className="text-sm text-ink-soft">
          Tag <code className="num text-ink">{tag}</code> · {formatDay(range.startDate)} to {formatDay(range.endDate)}
        </p>
      </div>

      <div className="flex justify-end">
        <RangePicker current={days} basePath={`/tickets/${key}`} />
      </div>

      {!detail ? (
        <Empty title={`No spend recorded for ${key} in this range`}>
          If someone worked on it, check that the branch names <code className="num">{key}</code>, the repo has the
          tokens-per-ticket hooks, and Claude Code points at the gateway. LiteLLM writes spend in batches, so the
          last minute may not show yet.
        </Empty>
      ) : (
        <>
          <Figures>
            <Figure label="Spend" value={formatUsd(detail.spend)} />
            <Figure
              label="Tokens"
              value={formatTokens(detail.totalTokens)}
              note={`${formatTokens(detail.promptTokens)} in · ${formatTokens(detail.completionTokens)} out`}
            />
            <Figure label="Cache reads" value={formatPercent(cacheReadShare(detail))} note="of input tokens" />
            <Figure
              label="Active days"
              value={String(detail.activeDays)}
              note={`${detail.requests.toLocaleString("en-US")} requests${detail.failedRequests ? `, ${detail.failedRequests} failed` : ""}`}
            />
          </Figures>

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-ink-soft">Spend per active day</h2>
            <DailySpendChart days={detail.days} />
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-ink-soft">By model</h2>
            <ul className="flex flex-col divide-y divide-rule border-y border-rule">
              {detail.models.map((model) => (
                <li key={model.model} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 py-3 text-sm sm:grid-cols-[14rem_1fr_auto]">
                  <span className="num">{model.model}</span>
                  <span className="num text-right sm:order-last">
                    {formatUsd(model.spend)} <span className="text-ink-soft">· {formatTokens(model.totalTokens)}</span>
                  </span>
                  <div className="col-span-2 sm:col-span-1">
                    <SpendBar value={model.spend} max={detail.spend} label={`${formatPercent(model.spend / detail.spend)} of spend`} />
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-ink-soft">
              What <code className="num text-ink">tpt report {key} --post</code> writes on the ticket
            </h2>
            <pre className="num overflow-x-auto rounded-lg border border-rule bg-sheet p-4 text-xs leading-relaxed whitespace-pre">
              {renderReport({ detail, tag, range, generatedAt: new Date() })}
            </pre>
          </section>
        </>
      )}
    </main>
  );
}
