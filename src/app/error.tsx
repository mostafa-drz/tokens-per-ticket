"use client";

export default function LedgerError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main role="alert" className="flex flex-col gap-3 rounded-lg border border-rule bg-sheet p-6">
      <h1 className="text-lg font-semibold">The ledger couldn&apos;t load its numbers</h1>
      <p className="max-w-prose text-sm text-ink-soft">
        {process.env.NODE_ENV === "development"
          ? error.message
          : "Check the server logs for details. The usual causes are a gateway that isn't reachable, a key without access to spend routes, or LEDGER_DATA=litellm without LEDGER_BASIC_AUTH."}
      </p>
      <button
        type="button"
        onClick={reset}
        className="self-start rounded-md border border-rule px-3 py-1.5 text-sm hover:bg-paper focus-visible:outline-2 focus-visible:outline-money"
      >
        Try again
      </button>
    </main>
  );
}
