import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { postgresStore } from "../src/store.mjs";

// Runs against a real Postgres when TPT_TEST_DATABASE_URL is set, e.g. the
// compose database: postgresql://litellm:litellm@localhost:5432/postgres
const url = process.env.TPT_TEST_DATABASE_URL;
const sha = (value) => createHash("sha256").update(value).digest("hex");

describe("postgres store migration", { skip: !url && "set TPT_TEST_DATABASE_URL to run" }, () => {
  const schema = `tpt_test_${Date.now()}`;
  let pool;

  before(async () => {
    pool = new pg.Pool({ connectionString: url, max: 1, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA ${schema}`);
    // The v0.1 layout: key_token held LiteLLM's sha256(key).
    await pool.query(`
      CREATE TABLE tpt_sessions (session_id text PRIMARY KEY, ticket text, branch text, repo text,
        key_token text NOT NULL, key_alias text, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE tpt_session_events (id bigserial PRIMARY KEY, session_id text NOT NULL, event text NOT NULL,
        ticket text, branch text, repo text, head text, key_alias text, created_at timestamptz NOT NULL DEFAULT now());
    `);
    await pool.query(`INSERT INTO tpt_sessions (session_id, ticket, key_token, key_alias) VALUES ('old-1', 'ENG-1', $1, 'jane')`, [sha("sk-jane")]);
  });

  after(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool?.end();
  });

  it("backfills fingerprints so existing sessions keep attributing, and runs again safely", async () => {
    const store = await postgresStore(pool);
    await postgresStore(pool);

    const session = await store.get("old-1");
    assert.equal(session.ticket, "ENG-1");
    assert.equal(session.key_fingerprint, sha(sha("sk-jane")));

    await store.put({ session_id: "old-1", key_fingerprint: sha(sha("sk-jane")), ticket: "ENG-2", branch: null, repo: null, event: "FileChanged", head: null });
    assert.equal((await store.get("old-1")).ticket, "ENG-2");

    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'tpt_sessions' ORDER BY column_name`,
      [schema],
    );
    assert.deepEqual(rows.map((r) => r.column_name), ["agent_id", "branch", "key_fingerprint", "repo", "session_id", "ticket", "updated_at"]);

    // Subagent records live next to the session's under the new key.
    await store.put({ session_id: "old-1", agent_id: "agent-1", key_fingerprint: sha(sha("sk-jane")), ticket: "ENG-3", branch: null, repo: null, event: "CwdChanged", head: null });
    assert.equal((await store.get("old-1", "agent-1")).ticket, "ENG-3");
    assert.equal((await store.get("old-1")).ticket, "ENG-2");
  });
});
