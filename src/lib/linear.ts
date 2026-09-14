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

/**
 * `--post` only knows Linear. For any other `tracker` in the contract, returns
 * why posting is refused, so a Jira key is never looked up in Linear.
 */
export function postUnsupportedReason(tracker: string): string | null {
  if (tracker.trim().toLowerCase() === "linear") return null;
  return `--post writes to Linear only, but ticket-contract.yaml sets tracker: ${tracker}. Run without --post and paste the report into your tracker.`;
}

type LinearConfig ={ apiKey: string; fetch?: typeof fetch };

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

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  comments: { nodes: { id: string; body: string }[] };
};

export async function getIssue(key: string, config: LinearConfig): Promise<LinearIssue> {
  const data = await graphql<{ issue: LinearIssue | null }>(
    config,
    `query TicketReportIssue($id: String!) {
      issue(id: $id) {
        id identifier title url
        comments(first: 100) { nodes { id body } }
      }
    }`,
    { id: key },
  );
  if (!data.issue) throw new LinearError(`Linear has no issue ${key}, or this API key can't see it.`);
  return data.issue;
}

/** Updates the existing report comment if there is one, otherwise creates it. */
export async function upsertReportComment(
  input: { key: string; body: string },
  config: LinearConfig,
): Promise<{ issue: LinearIssue; action: "created" | "updated" }> {
  const issue = await getIssue(input.key, config);
  const existing = issue.comments.nodes.find((comment) => comment.body.includes(REPORT_SIGNATURE));

  if (existing) {
    await graphql(
      config,
      `mutation TicketReportUpdate($id: String!, $input: CommentUpdateInput!) {
        commentUpdate(id: $id, input: $input) { success }
      }`,
      { id: existing.id, input: { body: input.body } },
    );
    return { issue, action: "updated" };
  }

  await graphql(
    config,
    `mutation TicketReportCreate($input: CommentCreateInput!) {
      commentCreate(input: $input) { success }
    }`,
    { input: { issueId: issue.id, body: input.body } },
  );
  return { issue, action: "created" };
}
