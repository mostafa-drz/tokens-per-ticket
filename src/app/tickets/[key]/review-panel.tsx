"use client";

import { useActionState } from "react";
import { reviewTicketSpend, type ReviewState } from "./actions";

export function ReviewPanel({ ticketKey, days, enabled }: { ticketKey: string; days: number; enabled: boolean }) {
  const [state, action, pending] = useActionState<ReviewState, FormData>(reviewTicketSpend, { status: "idle" });

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-rule bg-sheet p-4" aria-labelledby="review-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="review-heading" className="font-medium">
            Review this ticket&apos;s spend
          </h2>
          <p className="text-sm text-ink-soft">
            A model reads the numbers above and points out what&apos;s worth a conversation. Its own call is tagged{" "}
            <code className="num">app:ledger</code>, never this ticket.
          </p>
        </div>
        <form action={action}>
          <input type="hidden" name="key" value={ticketKey} />
          <input type="hidden" name="days" value={days} />
          <button
            type="submit"
            disabled={!enabled || pending}
            className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-paper hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-money disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Reviewing…" : "Review spend"}
          </button>
        </form>
      </div>

      {!enabled ? (
        <p className="text-sm text-ink-soft">
          Off in this deployment. Set <code className="num">LEDGER_REVIEW_MODEL</code> to a model your gateway serves.
        </p>
      ) : null}

      <div aria-live="polite">
        {state.status === "done" ? (
          <div className="border-t border-rule pt-3 text-sm leading-relaxed whitespace-pre-line">{state.text}</div>
        ) : null}
        {state.status === "error" ? (
          <p role="alert" className="border-t border-rule pt-3 text-sm text-warn">
            {state.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}
