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
    await pool.query(`INSERT INTO "LiteLLM_VerificationToken" VALUES ($1, null, null), ($2, true, null), ($3, null, now() - interval '1 day')`, [
      sha("sk-jane"),
      sha("sk-blocked"),
      sha("sk-expired"),
    ]);
  });

  after(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool?.query(`DROP SCHEMA IF EXISTS ${schema}_reg CASCADE`);
    await pool?.end();
  });

  it("accepts only active keys and keeps a session with the key that reported it", async () => {
    const store = await postgresStore(pool, { schema: `${schema}_reg` });
    assert.equal(await store.isActiveToken(sha("sk-jane")), true);
    assert.equal(await store.isActiveToken(sha("sk-blocked")), false);
    assert.equal(await store.isActiveToken(sha("sk-expired")), false);

    const report = { session_id: "s1", ticket: "ENG-1", branch: null, repo: null };
    assert.equal(await store.put({ ...report, key_token: sha("sk-jane") }), true);
    assert.equal(await store.put({ ...report, ticket: "ENG-9", key_token: sha("sk-other") }), false);
    assert.equal((await store.get("s1")).ticket, "ENG-1");
  });

  it("recreates its table if something drops it (a LiteLLM upgrade diffing its schema)", async () => {
    const store = await postgresStore(pool, { schema: `${schema}_reg` });
    await pool.query(`DROP TABLE ${schema}_reg.sessions`);
    assert.equal(await store.put({ session_id: "s2", ticket: "ENG-2", key_token: sha("sk-jane") }), true);
    assert.equal((await store.get("s2")).ticket, "ENG-2");
  });
});
