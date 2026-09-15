import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createServer, parseReport, rateLimiter } from "../src/server.mjs";
import { memoryStore } from "../src/store.mjs";

// LiteLLM stores a virtual key as sha256(key); the registry keeps the same.
const sha = (value) => createHash("sha256").update(value).digest("hex");

describe("registry", () => {
  const store = memoryStore({ tokens: new Set([sha("sk-jane"), sha("sk-omar")]) });
  const server = createServer({ store, internalToken: "gw-secret" });
  let base;

  before(async () => {
    await new Promise((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const report = (key, body) =>
    fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
    });
  const lookup = (id, token = "gw-secret") => fetch(`${base}/v1/sessions/${id}`, { headers: { Authorization: `Bearer ${token}` } });

  it("stores the ticket a developer's session is on, keeping only the key's hash", async () => {
    assert.equal((await report("sk-jane", { session_id: "s-1", ticket: "ENG-1", branch: "jane/eng-1", event: "SessionStart" })).status, 204);
    const res = await lookup("s-1");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual({ ...body, updated_at: undefined }, { ticket: "ENG-1", key_token: sha("sk-jane"), branch: "jane/eng-1", repo: null, updated_at: undefined });
    assert.ok(!JSON.stringify([...store.sessions.values()]).includes("sk-jane"));
  });

  it("follows a branch switch, and records a branch without a ticket", async () => {
    await report("sk-jane", { session_id: "s-1", ticket: "eng-2", branch: "jane/eng-2", event: "FileChanged" });
    assert.equal((await (await lookup("s-1")).json()).ticket, "ENG-2");
    await report("sk-jane", { session_id: "s-1", ticket: null, branch: "main", event: "FileChanged" });
    assert.equal((await (await lookup("s-1")).json()).ticket, null);
  });

  it("needs an active LiteLLM virtual key, and never lets another key take a session", async () => {
    assert.equal((await report(null, { session_id: "s-2", ticket: "ENG-1" })).status, 401);
    const unknown = await report("sk-master-or-revoked", { session_id: "s-2", ticket: "ENG-1" });
    assert.equal(unknown.status, 401);
    assert.match((await unknown.json()).error, /master key/);
    // Knowing Jane's stored hash isn't enough: it's not a key.
    assert.equal((await report(sha("sk-jane"), { session_id: "s-1", ticket: "ENG-9" })).status, 401);
    const taken = await report("sk-omar", { session_id: "s-1", ticket: "ENG-9" });
    assert.equal(taken.status, 403);
    assert.match((await taken.json()).error, /Start a new Claude Code session/);
  });

  it("serves lookups only to the gateway", async () => {
    assert.equal((await lookup("s-1", "sk-jane")).status, 401);
    assert.equal((await lookup("unknown-session")).status, 404);
  });

  it("rejects malformed reports, including tickets that aren't keys", async () => {
    assert.equal((await report("sk-jane", { session_id: "../etc", ticket: "ENG-1" })).status, 400);
    assert.equal((await report("sk-jane", { session_id: "s-3", ticket: "x,ENG-1" })).status, 400);
    assert.match(parseReport("{"), /JSON/);
  });
});

describe("rateLimiter", () => {
  it("allows a burst per window per key, then refuses until the window resets", () => {
    let t = 0;
    const allow = rateLimiter({ limit: 2, windowMs: 1000, now: () => t });
    assert.deepEqual([allow("a"), allow("a"), allow("a"), allow("b")], [true, true, false, true]);
    t = 1000;
    assert.equal(allow("a"), true);
  });
});
