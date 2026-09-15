import http from "node:http";

/**
 * The session registry: which ticket each Claude Code session is working on.
 *
 * Writers are Claude Code hooks on developer machines. They never send the
 * gateway key: only `key_fingerprint`, sha256(sha256(key)). LiteLLM stores a
 * key as sha256(key) and refuses that hash as a credential, and the extra
 * round means the fingerprint is not even that stored hash. A session belongs
 * to the fingerprint that first reports it, and the gateway plugin only tags a
 * call whose key produces the same fingerprint, so a write can only ever
 * attribute the writer's own calls.
 *
 * A subagent can have its own record (`agent_id`), so a subagent working in
 * another worktree doesn't move its parent session's spend.
 *
 * The one reader is the gateway plugin (gateway/tokens_per_ticket.py), which
 * authenticates with a shared internal token.
 *
 *   POST /v1/sessions                     report a session's ticket (JSON body)
 *   GET  /v1/sessions/:id[?agent_id=...]  look one up (gateway only, Bearer <TPT_REGISTRY_TOKEN>)
 *   GET  /healthz
 */

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 8 * 1024;

export function createServer({ store, internalToken, log = () => {}, limiter = rateLimiter() }) {
  if (!internalToken) throw new Error("TPT_REGISTRY_TOKEN is required, so only the gateway can read sessions.");

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://registry");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });

      if (req.method === "POST" && url.pathname === "/v1/sessions") {
        // Writes are unauthenticated by design (they carry a fingerprint, not a
        // credential), so cap how fast one client can write.
        if (!limiter(req.socket.remoteAddress ?? "unknown")) return send(res, 429, { error: "Too many reports. Slow down." });
        const report = parseReport(await readBody(req));
        if (typeof report === "string") return send(res, 400, { error: report });

        const owners = [await store.get(report.session_id)];
        if (report.agent_id) owners.push(await store.get(report.session_id, report.agent_id));
        if (owners.some((existing) => existing && existing.key_fingerprint !== report.key_fingerprint)) {
          // A session belongs to the key that first reported it. Anyone else
          // re-pointing it would move a colleague's spend onto another ticket.
          return send(res, 403, { error: "This session was reported with a different key." });
        }
        await store.put(report);
        log(`session ${report.session_id.slice(0, 8)}${report.agent_id ? `/${report.agent_id}` : ""} ${report.event} → ${report.ticket ?? "(no ticket)"}`);
        res.writeHead(204).end();
        return;
      }

      const lookup = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (req.method === "GET" && lookup) {
        if (bearer(req) !== internalToken) return send(res, 401, { error: "Gateway token required." });
        const sessionId = decodeURIComponent(lookup[1]);
        const agentId = url.searchParams.get("agent_id") ?? "";
        if (!SESSION_ID.test(sessionId) || (agentId && !SESSION_ID.test(agentId))) return send(res, 404, { error: "Unknown session." });
        // A subagent's own record wins; otherwise it counts toward its session.
        const session = (agentId && (await store.get(sessionId, agentId))) || (await store.get(sessionId));
        if (!session) return send(res, 404, { error: "Unknown session." });
        return send(res, 200, {
          ticket: session.ticket,
          key_fingerprint: session.key_fingerprint,
          branch: session.branch,
          repo: session.repo,
          updated_at: session.updated_at,
        });
      }

      send(res, 404, { error: "Not found." });
    } catch (error) {
      log(`error: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) send(res, 500, { error: "Registry error." });
    }
  });
}

/** Validates a report body. Returns the report, or an error message. */
export function parseReport(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return "Body must be JSON.";
  }
  if (!data || typeof data !== "object") return "Body must be a JSON object.";
  if (typeof data.session_id !== "string" || !SESSION_ID.test(data.session_id)) return "session_id is missing or malformed.";
  const text = (value, max) => (typeof value === "string" && value.length <= max ? value : null);
  if (typeof data.key_fingerprint !== "string" || !FINGERPRINT.test(data.key_fingerprint)) return "key_fingerprint must be sha256(sha256(gateway key)) in lowercase hex.";
  if (data.ticket !== null && text(data.ticket, 64) === null) return "ticket must be a string of at most 64 characters, or null.";
  if (data.agent_id !== undefined && data.agent_id !== null && (typeof data.agent_id !== "string" || !SESSION_ID.test(data.agent_id))) return "agent_id is malformed.";
  return {
    session_id: data.session_id,
    agent_id: data.agent_id ?? "",
    key_fingerprint: data.key_fingerprint,
    ticket: data.ticket,
    branch: text(data.branch, 256),
    repo: text(data.repo, 256),
    event: text(data.event, 40) ?? "unknown",
    head: text(data.head, 64),
  };
}

/**
 * A fixed-window limit per client address: `limit` writes per `windowMs`.
 * Hooks report a few times per session, so the default is generous for people
 * and tight for scripts.
 */
export function rateLimiter({ limit = 120, windowMs = 60_000, now = Date.now } = {}) {
  const windows = new Map();
  return (client) => {
    const t = now();
    const current = windows.get(client);
    if (!current || t - current.start >= windowMs) {
      if (windows.size > 10_000) windows.clear();
      windows.set(client, { start: t, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  };
}

function bearer(req) {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
