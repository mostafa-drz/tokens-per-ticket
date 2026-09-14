import type { TicketRow } from "./ledger.ts";

/**
 * `pnpm gateway:smoke` helpers.
 *
 * The smoke test must prove that *this run's* calls were written. Checking
 * which SMOKE-* tickets exist is not enough: on a second run they already
 * exist (a false pass), and on a shared gateway someone else's SMOKE-3 makes an
 * exact count never match (a false failure). So it compares request counts
 * per key before and after sending.
 */

export function requestsByKey(rows: TicketRow[], keys: string[]): Record<string, number> {
  return Object.fromEntries(keys.map((key) => [key, rows.find((row) => row.key === key)?.requests ?? 0]));
}

export function smokeLanded(
  baseline: Record<string, number>,
  current: Record<string, number>,
  sent: Record<string, number>,
): boolean {
  return Object.entries(sent).every(([key, count]) => (current[key] ?? 0) - (baseline[key] ?? 0) >= count);
}
