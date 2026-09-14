import Link from "next/link";
import { RANGE_OPTIONS, type RangeDays } from "@/lib/data";

export function RangePicker({ current, basePath }: { current: RangeDays; basePath: string }) {
  return (
    <nav aria-label="Date range" className="flex gap-1 text-sm">
      {RANGE_OPTIONS.map((days) => (
        <Link
          key={days}
          href={`${basePath}?days=${days}`}
          aria-current={days === current ? "page" : undefined}
          className={`rounded-md px-2.5 py-1 ${
            days === current ? "bg-ink text-paper" : "text-ink-soft hover:bg-sheet hover:text-ink"
          }`}
        >
          {days} days
        </Link>
      ))}
    </nav>
  );
}

export function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs uppercase tracking-wider text-ink-soft">{label}</dt>
      <dd className="num text-2xl font-medium">{value}</dd>
      {note ? <dd className="text-xs text-ink-soft">{note}</dd> : null}
    </div>
  );
}

export function Figures({ children }: { children: React.ReactNode }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-rule py-5 sm:grid-cols-4">{children}</dl>
  );
}

/** A spend bar scaled to the largest value in its table. */
export function SpendBar({ value, max, label }: { value: number; max: number; label: string }) {
  const width = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="h-1.5 w-full rounded-full bg-rule" role="img" aria-label={label}>
      <div className="h-1.5 rounded-full bg-money" style={{ width: `${width}%` }} />
    </div>
  );
}

export function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-rule bg-sheet px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      <div className="mx-auto mt-2 max-w-prose text-sm text-ink-soft">{children}</div>
    </div>
  );
}
