import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { formatDay, formatPercent, formatTokens, formatUsd } from "./format";
import { cacheReadShare, type TicketDetail } from "./ledger";

/**
 * "Review this ticket's spend": the app's one AI feature.
 *
 * It calls a model through the same LiteLLM gateway, over the OpenAI-compatible
 * API, and tags the call `app:ledger`. That tag is not a ticket tag, so the
 * app's own runtime tokens never leak into a ticket's development cost.
 */

export const APP_TAG = "app:ledger";

export const REVIEW_INSTRUCTIONS = `You review the AI token spend of one software ticket for an engineering lead.

Write at most three short observations, one per line, each starting with "- ".
Only say what the numbers support. Useful angles:
- Model mix: a top-tier model doing most of the work on what looks like routine work.
- Prompt cache: a low cache-read share on a ticket that ran many requests or many days.
- Failed requests: a noticeable share of all requests.
- Duration: spend spread over many active days can mean the ticket is bigger than scoped.
If nothing stands out, say so in one line.

The number is a signal for a conversation, never a verdict on the developer. No preamble, no summary.`;

export function reviewPrompt(detail: TicketDetail & { title?: string }): string {
  const models = detail.models
    .map((m) => `  ${m.model}: ${formatUsd(m.spend)}, ${formatTokens(m.totalTokens)} tokens, ${m.requests} requests`)
    .join("\n");
  return [
    `Ticket ${detail.key}${detail.title ? `: ${detail.title}` : ""}`,
    `Spend: ${formatUsd(detail.spend)}`,
    `Tokens: ${formatTokens(detail.totalTokens)} (${formatTokens(detail.promptTokens)} input, ${formatTokens(detail.completionTokens)} output)`,
    `Prompt cache reads: ${formatPercent(cacheReadShare(detail))} of input tokens`,
    `Requests: ${detail.requests}, failed: ${detail.failedRequests}`,
    `Active days: ${detail.activeDays} (${formatDay(detail.firstDay)} to ${formatDay(detail.lastDay)})`,
    `By model:\n${models}`,
  ].join("\n");
}

export function reviewModel(): string | null {
  return process.env.LEDGER_REVIEW_MODEL?.trim() || null;
}

export async function reviewSpend(detail: TicketDetail & { title?: string }): Promise<string> {
  const model = reviewModel();
  const apiKey = process.env.LITELLM_API_KEY;
  if (!model || !apiKey) throw new Error("Set LEDGER_REVIEW_MODEL and LITELLM_API_KEY to enable reviews.");

  const gateway = createOpenAICompatible({
    name: "litellm",
    baseURL: new URL("/v1", process.env.LITELLM_BASE_URL ?? "http://localhost:4000").toString(),
    apiKey,
    headers: { "x-litellm-tags": APP_TAG },
  });

  const { text } = await generateText({
    model: gateway.chatModel(model),
    system: REVIEW_INSTRUCTIONS,
    prompt: reviewPrompt(detail),
  });
  return text.trim();
}
