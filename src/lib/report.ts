import { formatDay, formatPercent, formatTokens, formatUsd } from "./format.ts";
import { cacheReadShare, type TicketDetail } from "./ledger.ts";

/**
 * The ticket report as Markdown: printed by `pnpm ticket:report` and posted
 * as a single, updated-in-place comment on the Linear ticket.
 */

/** Present in every posted comment, so the next run updates it instead of adding another. */
export const REPORT_SIGNATURE = "Updated by tokens-per-ticket";

export function renderReport(input: {
  detail: TicketDetail;
  tag: string;
  range: { startDate: string; endDate: string };
  generatedAt: Date;
}): string {
  const { detail, tag, range } = input;
  const failed = detail.failedRequests > 0 ? ` (${detail.failedRequests} failed)` : "";

  const lines = [
    `### AI development spend · ${detail.key}`,
    "",
    "| | |",
    "|---|---|",
    `| Spend | **${formatUsd(detail.spend)}** |`,
    `| Tokens | ${formatTokens(detail.totalTokens)} (${formatTokens(detail.promptTokens)} in · ${formatTokens(detail.completionTokens)} out) |`,
    `| Prompt cache reads | ${formatPercent(cacheReadShare(detail))} of input tokens |`,
    `| Requests | ${detail.requests}${failed} |`,
    `| Active days | ${detail.activeDays} (${formatDay(detail.firstDay)} → ${formatDay(detail.lastDay)}) |`,
  ];

  if (detail.models.length > 0) {
    lines.push("", "| Model | Spend | Tokens | Requests |", "|---|---:|---:|---:|");
    for (const model of detail.models) {
      lines.push(
        `| ${model.model} | ${formatUsd(model.spend)} | ${formatTokens(model.totalTokens)} | ${model.requests} |`,
      );
    }
  }

  lines.push(
    "",
    `_LiteLLM tag \`${tag}\`, ${range.startDate} → ${range.endDate} (UTC). ${REPORT_SIGNATURE}, ${input.generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC._`,
  );

  return lines.join("\n");
}
