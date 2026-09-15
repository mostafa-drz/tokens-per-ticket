import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createHash } from "node:crypto";
import { createServer, parseReport, rateLimiter } from "../src/server.mjs";
import { memoryStore } from "../src/store.mjs";

// What hooks send: sha256(sha256(key)). The registry never sees a key.
const sha = (value) => createHash("sha256").update(value).digest("hex");
const JANE = sha(sha("sk-jane"));
const OMAR = sha(sha("sk-omar"));

describe("registry", () => {
  const store = memoryStore();
  const server = createServer({ store, internalToken: "gw-secret" });
  let base;

  before(async () => {
    await new Promise((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const report = (fingerprint, body) =>
    fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key_fingerprint: fingerprint, ...body }),
    });
  const lookup = (id, token = "gw-secret") =>
    fetch(`${base}/v1/sessions/${id}`, { headers: { Authorization: `Bearer ${token}` } });

  it("stores the ticket a developer's session is on and serves it to the gateway", async () => {
    assert.equal((await report(JANE, { session_id: "s-1", ticket: "ENG-1", branch: "jane/eng-1", event: "SessionStart" })).status, 204);
    const res = await lookup("s-1");
    assert.equal(res.status, 200);
    assert.deepEqual(
      { ...(await res.json()), updated_at: undefined },
      { ticket: "ENG-1", key_fingerprint: JANE, branch: "jane/eng-1", repo: null, updated_at: undefined },
    );
  });

  it("follows a branch switch and keeps the timeline", async () => {
    await report(JANE, { session_id: "s-1", ticket: "ENG-2", branch: "jane/eng-2", event: "FileChanged" });
    assert.equal((await (await lookup("s-1")).json()).ticket, "ENG-2");
    assert.deepEqual(
      store.events.filter((e) => e.session_id === "s-1").map((e) => e.ticket),
      ["ENG-1", "ENG-2"],
    );
  });

  it("records a session with no ticket, so the gateway stops tagging it", async () => {
    await report(JANE, { session_id: "s-1", ticket: null, branch: "main", event: "FileChanged" });
    assert.equal((await (await lookup("s-1")).json()).ticket, null);
  });

  it("refuses a different key re-pointing someone else's session, and a missing fingerprint", async () => {
    assert.equal((await report(OMAR, { session_id: "s-1", ticket: "ENG-9" })).status, 403);
    assert.equal((await report("not-a-fingerprint", { session_id: "s-2", ticket: "ENG-1" })).status, 400);
    assert.equal((await report(undefined, { session_id: "s-2", ticket: "ENG-1" })).status, 400);
  });

  it("keeps a subagent's ticket separate from its session's", async () => {
    await report(JANE, { session_id: "s-3", ticket: "ENG-10", event: "SessionStart" });
    await report(JANE, { session_id: "s-3", agent_id: "agent-1", ticket: "ENG-11", event: "CwdChanged" });
    assert.equal((await (await lookup("s-3")).json()).ticket, "ENG-10");
    assert.equal((await (await fetch(`${base}/v1/sessions/s-3?agent_id=agent-1`, { headers: { Authorization: "Bearer gw-secret" } })).json()).ticket, "ENG-11");
    // A subagent without its own record counts toward the session.
    assert.equal((await (await fetch(`${base}/v1/sessions/s-3?agent_id=agent-2`, { headers: { Authorization: "Bearer gw-secret" } })).json()).ticket, "ENG-10");
    // Another key can't add a subagent record to someone else's session.
    assert.equal((await report(OMAR, { session_id: "s-3", agent_id: "agent-9", ticket: "ENG-99" })).status, 403);
  });

  it("serves lookups only to the gateway", async () => {
    assert.equal((await lookup("s-1", JANE)).status, 401);
    assert.equal((await lookup("unknown-session")).status, 404);
  });

  it("rejects malformed reports", async () => {
    assert.equal((await report(JANE, { session_id: "../etc", ticket: "ENG-1" })).status, 400);
    assert.match(parseReport("{"), /JSON/);
    assert.match(parseReport(JSON.stringify({ session_id: "s", key_fingerprint: JANE, ticket: 5 })), /ticket/);
  });
});

describe("rateLimiter", () => {
  it("allows a burst per window, then refuses until the window resets", () => {
    let t = 0;
    const allow = rateLimiter({ limit: 2, windowMs: 1000, now: () => t });
    assert.deepEqual([allow("a"), allow("a"), allow("a"), allow("b")], [true, true, false, true]);
    t = 1000;
    assert.equal(allow("a"), true);
  });
});
