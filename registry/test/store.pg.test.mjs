import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { postgresStore } from "../src/store.mjs";

// Runs against a real Postgres when TPT_TEST_DATABASE_URL is set, e.g. the
// compose database from inside its network: postgresql://litellm:litellm@db:5432/litellm
const url = process.env.TPT_TEST_DATABASE_URL;
const sha = (value) => createHash("sha256").update(value).digest("hex");

describe("postgres store", { skip: !url && "set TPT_TEST_DATABASE_URL to run" }, () => {
  const schema = `tpt_test_${Date.now()}`;
  let pool;

  before(async () => {
    pool = new pg.Pool({ connectionString: url, max: 1, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA ${schema}`);
    // The part of LiteLLM's key table the registry reads.
    await pool.query(`CREATE TABLE "LiteLLM_VerificationToken" (token text PRIMARY KEY, blocked boolean, expires timestamptz)`);
    await pool.query(`INSERT INTO "LiteLLM_VerificationToken" VALUES ($1, null, null), ($2, true, null)`, [sha("sk-jane"), sha("sk-blocked")]);
  });

  after(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool?.end();
  });

  it("knows active keys by fingerprint, keeps owners, and records events only for accepted writes", async () => {
    const store = await postgresStore(pool);
    assert.equal(await store.isKnownFingerprint(sha(sha("sk-jane"))), true);
    assert.equal(await store.isKnownFingerprint(sha(sha("sk-blocked"))), false);

    const report = { session_id: "s1", ticket: "ENG-1", branch: null, repo: null, event: "SessionStart", head: null };
    assert.equal(await store.put({ ...report, key_fingerprint: sha(sha("sk-jane")) }), true);
    assert.equal(await store.put({ ...report, ticket: "ENG-9", key_fingerprint: sha(sha("sk-other")) }), false);
    assert.equal((await store.get("s1")).ticket, "ENG-1");
    const { rows } = await pool.query("SELECT ticket FROM tpt_session_events ORDER BY id");
    assert.deepEqual(rows.map((r) => r.ticket), ["ENG-1"]);
  });
});
