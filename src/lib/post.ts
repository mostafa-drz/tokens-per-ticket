import { upsertJiraReport } from "./jira.ts";
import { upsertLinearReport } from "./linear.ts";

/**
 * Posts the report to the tracker named in tokens-per-ticket.yaml.
 * Credentials come from the environment (.env.local).
 */

type Env = Record<string, string | undefined>;
export type Poster = (input: { key: string; body: string }) => Promise<{ url: string; identifier: string; action: "created" | "updated" }>;

/** Returns a poster for the tracker, or the reason posting can't work. */
export function reportPoster(tracker: string, env: Env = process.env): Poster | string {
  switch (tracker.trim().toLowerCase()) {
    case "linear": {
      if (!env.LINEAR_API_KEY) return "Set LINEAR_API_KEY in .env.local to post to Linear.";
      const apiKey = env.LINEAR_API_KEY;
      return (input) => upsertLinearReport(input, { apiKey });
    }
    case "jira": {
      const missing = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"].filter((name) => !env[name]);
      if (missing.length) return `Set ${missing.join(", ")} in .env.local to post to Jira.`;
      const config = { baseUrl: env.JIRA_BASE_URL!, email: env.JIRA_EMAIL!, apiToken: env.JIRA_API_TOKEN! };
      return (input) => upsertJiraReport(input, config);
    }
    default:
      return `--post supports tracker: linear or jira, but tokens-per-ticket.yaml sets tracker: ${tracker}. Run without --post and paste the report into your tracker.`;
  }
}
