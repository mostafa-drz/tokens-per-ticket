"use server";

import { loadContract, normalizeTicketKey } from "@/lib/contract";
import { getTicket, parseRange } from "@/lib/data";
import { reviewModel, reviewSpend } from "@/lib/review";

export type ReviewState = { status: "idle" } | { status: "done"; text: string } | { status: "error"; message: string };

/**
 * Re-reads the ticket on the server rather than trusting numbers from the
 * browser, then asks the review model about them.
 */
export async function reviewTicketSpend(_previous: ReviewState, form: FormData): Promise<ReviewState> {
  if (!reviewModel()) return { status: "error", message: "Reviews are off. Set LEDGER_REVIEW_MODEL to turn them on." };

  const key = normalizeTicketKey(String(form.get("key") ?? ""), loadContract(process.cwd()));
  if (!key) return { status: "error", message: "That isn't a ticket key." };

  try {
    const { detail } = await getTicket(key, parseRange(String(form.get("days") ?? "")));
    if (!detail) return { status: "error", message: `Nothing to review: ${key} has no spend in this range.` };
    return { status: "done", text: await reviewSpend(detail) };
  } catch (error) {
    return {
      status: "error",
      message: `The review model call failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
