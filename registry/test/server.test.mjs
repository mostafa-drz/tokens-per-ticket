import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { liteLLMKeyValidator } from "../src/litellm-auth.mjs";
import { createServer, parseReport } from "../src/server.mjs";
import { memoryStore } from "../src/store.mjs";

const KEYS = { "sk-jane": { token: "hash-jane", alias: "jane" }, "sk-omar": { token: "hash-omar", alias: "omar" } };

describe("registry", () => {
  const store = memoryStore();
  const server = createServer({ store, validateKey: async (key) => KEYS[key] ?? null, internalToken: "gw-secret" });
  let base;

  before(async () => {
    await new Promise((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const report = (key, body) =>
    fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const lookup = (id, token = "gw-secret") =>
    fetch(`${base}/v1/sessions/${id}`, { headers: { Authorization: `Bearer ${token}` } });

  it("stores the ticket a developer's session is on and serves it to the gateway", async () => {
    assert.equal((await report("sk-jane", { session_id: "s-1", ticket: "ENG-1", branch: "jane/eng-1", event: "SessionStart" })).status, 204);
    const res = await lookup("s-1");
    assert.equal(res.status, 200);
    assert.deepEqual(
      { ...(await res.json()), updated_at: undefined },
      { ticket: "ENG-1", key_token: "hash-jane", branch: "jane/eng-1", repo: null, updated_at: undefined },
    );
  });

  it("follows a branch switch and keeps the timeline", async () => {
    await report("sk-jane", { session_id: "s-1", ticket: "ENG-2", branch: "jane/eng-2", event: "FileChanged" });
    assert.equal((await (await lookup("s-1")).json()).ticket, "ENG-2");
    assert.deepEqual(
      store.events.filter((e) => e.session_id === "s-1").map((e) => e.ticket),
      ["ENG-1", "ENG-2"],
    );
  });

  it("records a session with no ticket, so the gateway stops tagging it", async () => {
    await report("sk-jane", { session_id: "s-1", ticket: null, branch: "main", event: "FileChanged" });
    assert.equal((await (await lookup("s-1")).json()).ticket, null);
  });

  it("refuses reports from unknown keys and from a different key for the same session", async () => {
    assert.equal((await report("sk-nope", { session_id: "s-2", ticket: "ENG-1" })).status, 401);
    assert.equal((await report("sk-omar", { session_id: "s-1", ticket: "ENG-9" })).status, 403);
  });

  it("serves lookups only to the gateway", async () => {
    assert.equal((await lookup("s-1", "sk-jane")).status, 401);
    assert.equal((await lookup("unknown-session")).status, 404);
  });

  it("rejects malformed reports", async () => {
    assert.equal((await report("sk-jane", { session_id: "../etc", ticket: "ENG-1" })).status, 400);
    assert.match(parseReport("{"), /JSON/);
    assert.match(parseReport(JSON.stringify({ session_id: "s", ticket: 5 })), /ticket/);
  });
});

describe("liteLLMKeyValidator", () => {
  it("asks LiteLLM about the key with the key itself, and caches the answer", async () => {
    let calls = 0;
    const validate = liteLLMKeyValidator({
      baseUrl: "http://gateway.test",
      fetchImpl: async (url, init) => {
        calls++;
        assert.equal(String(url), "http://gateway.test/key/info");
        assert.equal(init.headers.Authorization, "Bearer sk-jane");
        return Response.json({ key: "hash-jane", info: { key_alias: "jane" } });
      },
    });
    assert.deepEqual(await validate("sk-jane"), { token: "hash-jane", alias: "jane" });
    await validate("sk-jane");
    assert.equal(calls, 1);
  });

  it("treats a rejected key as unknown", async () => {
    const validate = liteLLMKeyValidator({ baseUrl: "http://gateway.test", fetchImpl: async () => new Response("", { status: 401 }) });
    assert.equal(await validate("sk-bad"), null);
  });
});
