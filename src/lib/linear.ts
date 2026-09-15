import { REPORT_SIGNATURE } from "./report.ts";

/**
 * The smallest Linear client this repo needs: find a ticket, then create or
 * update one report comment on it.
 *
 * Plain GraphQL over fetch, per https://linear.app/developers/graphql:
 * personal API keys go in the Authorization header without "Bearer", and
 * issue(id:) accepts the short identifier (ENG-123).
 */

const ENDPOINT = "https://api.linear.app/graphql";

export class LinearError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearError";
  }
}

type LinearConfig = { apiKey: string; fetch?: typeof fetch };

async function graphql<T>(config: LinearConfig, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await (config.fetch ?? fetch)(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: config.apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
  if (!response.ok || body.errors?.length || !body.data) {
    const detail = body.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`;
    throw new LinearError(`Linear API error: ${detail}`);
  }
  return body.data;
}

type CommentPage = {
  nodes: { id: string; body: string; user: { id: string } | null }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

type IssuePage = {
  viewer: { id: string };
  issue: { id: string; identifier: string; url: string; comments: CommentPage } | null;
};

/**
 * Updates this API key's own report comment if there is one, otherwise
 * creates it. Pages through all comments, and never edits a comment someone
 * else wrote, even if it quotes the report.
 */
export async function upsertLinearReport(
  input: { key: string; body: string },
  config: LinearConfig,
): Promise<{ url: string; identifier: string; action: "created" | "updated" }> {
  let after: string | null = null;
  let issue: IssuePage["issue"] = null;
  let existing: string | undefined;

  do {
    const page: IssuePage = await graphql<IssuePage>(
      config,
      `query TicketReportIssue($id: String!, $after: String) {
        viewer { id }
        issue(id: $id) {
          id identifier url
          comments(first: 100, after: $after) {
            nodes { id body user { id } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: input.key, after },
    );
    if (!page.issue) throw new LinearError(`Linear has no issue ${input.key}, or this API key can't see it.`);
    issue = page.issue;
    existing = page.issue.comments.nodes.find((c) => c.user?.id === page.viewer.id && c.body.includes(REPORT_SIGNATURE))?.id;
    after = !existing && page.issue.comments.pageInfo.hasNextPage ? page.issue.comments.pageInfo.endCursor : null;
  } while (after);

  const result = existing
    ? await graphql<{ commentUpdate: { success: boolean } }>(
        config,
        `mutation TicketReportUpdate($id: String!, $input: CommentUpdateInput!) {
          commentUpdate(id: $id, input: $input) { success }
        }`,
        { id: existing, input: { body: input.body } },
      ).then((d) => d.commentUpdate.success)
    : await graphql<{ commentCreate: { success: boolean } }>(
        config,
        `mutation TicketReportCreate($input: CommentCreateInput!) {
          commentCreate(input: $input) { success }
        }`,
        { input: { issueId: issue!.id, body: input.body } },
      ).then((d) => d.commentCreate.success);
  if (!result) throw new LinearError("Linear didn't save the comment.");

  return { url: issue!.url, identifier: issue!.identifier, action: existing ? "updated" : "created" };
}
