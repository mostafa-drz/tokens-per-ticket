import { headers } from "next/headers";
import { connection } from "next/server";
import { basicAuthOk } from "./basic-auth";
import { loadContract, ticketTag, type TicketContract } from "./contract";
import { summarizeTicket, summarizeTickets, type TicketDetail, type TicketRow } from "./ledger";
import { fetchTagActivity, lastDays, type TagActivityQuery } from "./litellm";
import { sampleTagActivity, sampleTitle } from "./sample";

/**
 * Where the app's numbers come from. Server-only: it reads the LiteLLM admin key.
 *
 * LEDGER_DATA=sample (default) needs nothing and is what a public demo deploy
 * should use. LEDGER_DATA=litellm reads a real gateway, and in production it
 * refuses to run unless LEDGER_BASIC_AUTH protects the app, because the page
 * shows spend for the whole organization.
 */

export type DataSource = "sample" | "litellm";

export const RANGE_OPTIONS = [7, 30, 90] as const;
export type RangeDays = (typeof RANGE_OPTIONS)[number];

export class LedgerConfigError extends Error {}

/**
 * Re-checks LEDGER_BASIC_AUTH where the gateway key is used, instead of
 * trusting that src/proxy.ts ran. Next.js treats Proxy as an optimistic check
 * and Server Actions as public endpoints (see src/lib/basic-auth.ts).
 */
export async function isAuthorized(): Promise<boolean> {
  return basicAuthOk((await headers()).get("authorization"), process.env.LEDGER_BASIC_AUTH);
}

export function dataSource(): DataSource {
  return process.env.LEDGER_DATA === "litellm" ? "litellm" : "sample";
}

export function parseRange(value: string | string[] | undefined): RangeDays {
  const days = Number(Array.isArray(value) ? value[0] : value);
  return (RANGE_OPTIONS as readonly number[]).includes(days) ? (days as RangeDays) : 30;
}

function contract(): TicketContract {
  return loadContract(process.cwd());
}

async function activity(query: TagActivityQuery) {
  // Spend changes by the minute. Never prerender it at build time.
  await connection();

  if (dataSource() === "sample") return sampleTagActivity(query, contract());

  if (process.env.NODE_ENV === "production" && !process.env.LEDGER_BASIC_AUTH) {
    throw new LedgerConfigError(
      "LEDGER_DATA=litellm shows your organization's spend. Set LEDGER_BASIC_AUTH=user:password before deploying it.",
    );
  }
  if (!(await isAuthorized())) throw new LedgerConfigError("Authentication required.");
  const apiKey = process.env.LITELLM_API_KEY;
  if (!apiKey) throw new LedgerConfigError("LEDGER_DATA=litellm needs LITELLM_API_KEY.");

  return fetchTagActivity(query, {
    baseUrl: process.env.LITELLM_BASE_URL ?? "http://localhost:4000",
    apiKey,
  });
}

export type LedgerRow = TicketRow & { title?: string };

export async function getTickets(days: RangeDays): Promise<{ rows: LedgerRow[]; range: ReturnType<typeof lastDays> }> {
  const range = lastDays(days);
  const rows = summarizeTickets(await activity(range), contract());
  return { rows: rows.map((row) => ({ ...row, title: titleFor(row.key) })), range };
}

export async function getTicket(
  key: string,
  days: RangeDays,
): Promise<{ detail: (TicketDetail & { title?: string }) | null; tag: string; range: ReturnType<typeof lastDays> }> {
  const range = lastDays(days);
  const tag = ticketTag(key, contract());
  const detail = summarizeTicket(key, await activity({ tags: [tag], ...range }));
  return { detail: detail && { ...detail, title: titleFor(key) }, tag, range };
}

function titleFor(key: string): string | undefined {
  // Live mode shows keys only. Titles live in Linear; fetching them is left
  // out to keep the app free of a second credential.
  return dataSource() === "sample" ? sampleTitle(key) : undefined;
}
