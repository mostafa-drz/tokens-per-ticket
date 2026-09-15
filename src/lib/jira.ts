import { REPORT_SIGNATURE } from "./report.ts";

/**
 * Jira Cloud: create or update one report comment on an issue.
 *
 * REST API v3 (https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/):
 * basic auth with an Atlassian account email and API token, comment bodies in
 * Atlassian Document Format. The report goes in one code block, which keeps
 * its table readable without converting Markdown.
 */

export class JiraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraError";
  }
}

export type JiraConfig = { baseUrl: string; email: string; apiToken: string; fetch?: typeof fetch };

type JiraComment = { id: string; author?: { accountId?: string }; body?: unknown };

async function jira<T>(config: JiraConfig, method: string, path: string, body?: unknown): Promise<T> {
  const response = await (config.fetch ?? fetch)(new URL(path, config.baseUrl), {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { errorMessages?: string[] } | null;
    const hint = response.status === 404 ? " Check the issue key, and that this account can see it." : "";
    throw new JiraError(`Jira API ${response.status}${detail?.errorMessages?.length ? `: ${detail.errorMessages.join("; ")}` : ""}.${hint}`);
  }
  return (response.status === 204 ? null : await response.json()) as T;
}

/** The report as an Atlassian Document Format document: one code block. */
export function reportDocument(report: string) {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "codeBlock", attrs: { language: "markdown" }, content: [{ type: "text", text: report }] }],
  };
}

/**
 * Updates this account's own report comment if there is one, otherwise adds
 * it. Pages through all comments and never edits someone else's.
 */
export async function upsertJiraReport(
  input: { key: string; body: string },
  config: JiraConfig,
): Promise<{ url: string; identifier: string; action: "created" | "updated" }> {
  const me = await jira<{ accountId: string }>(config, "GET", "/rest/api/3/myself");
  const issuePath = `/rest/api/3/issue/${encodeURIComponent(input.key)}`;

  let existing: string | undefined;
  for (let startAt = 0; ; startAt += 100) {
    const page = await jira<{ comments: JiraComment[]; total: number }>(config, "GET", `${issuePath}/comment?startAt=${startAt}&maxResults=100`);
    existing = page.comments.find((c) => c.author?.accountId === me.accountId && JSON.stringify(c.body ?? "").includes(REPORT_SIGNATURE))?.id;
    if (existing || startAt + page.comments.length >= page.total || page.comments.length === 0) break;
  }

  const body = { body: reportDocument(input.body) };
  if (existing) await jira(config, "PUT", `${issuePath}/comment/${existing}`, body);
  else await jira(config, "POST", `${issuePath}/comment`, body);

  return { url: new URL(`/browse/${input.key}`, config.baseUrl).toString(), identifier: input.key, action: existing ? "updated" : "created" };
}
