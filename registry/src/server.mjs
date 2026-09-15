import http from "node:http";

/**
 * The session registry: which ticket each Claude Code session is working on.
 *
 * Writers are Claude Code hooks on developer machines. They never send the
 * gateway key, only `key_fingerprint` = sha256(sha256(key)). LiteLLM stores a
 * key as sha256(key) and refuses that hash as a credential; one more round
 * gives a value that works nowhere as a credential. Reports are accepted only
 * for fingerprints of active LiteLLM keys, a session belongs to the key that
 * first reported it, and the gateway plugin only tags calls from that key, so
 * a report can only ever attribute the reporter's own calls.
 *
 * Subagents share their session's id and count toward its ticket: Claude Code
 * sends `agent_id` to hooks only on tool events, which these hooks don't use.
 *
 * The one reader is the gateway plugin (gateway/tokens_per_ticket.py), which
 * authenticates with a shared internal token.
 *
 *   POST /v1/sessions        report a session's ticket (JSON body)
 *   GET  /v1/sessions/:id    look one up (gateway only, Bearer <TPT_REGISTRY_TOKEN>)
 *   GET  /healthz
 */

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const TICKET = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY_BYTES = 8 * 1024;

export function createServer({ store, internalToken, log = () => {}, limiter = rateLimiter() }) {
  if (!internalToken) throw new Error("TPT_REGISTRY_TOKEN is required, so only the gateway can read sessions.");

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://registry");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });

      if (req.method === "POST" && url.pathname === "/v1/sessions") {
        const report = parseReport(await readBody(req));
        if (typeof report === "string") return send(res, 400, { error: report });
        // Per key, not per address: behind an HTTPS proxy everyone shares one.
        if (!limiter(report.key_fingerprint)) return send(res, 429, { error: "Too many reports for this key. Slow down." });
        if (!(await store.isKnownFingerprint(report.key_fingerprint))) {
          return send(res, 403, { error: "This key isn't an active LiteLLM virtual key (the master key can't be attributed)." });
        }
        if (!(await store.put(report))) {
          // A session belongs to the key that first reported it: re-pointing it
          // would move a colleague's spend, and after a key change the calls
          // wouldn't match anyway.
          return send(res, 403, { error: "This session was reported with a different key. Start a new Claude Code session." });
        }
        log(`session ${report.session_id.slice(0, 8)} ${report.event} → ${report.ticket ?? "(no ticket)"}`);
        res.writeHead(204).end();
        return;
      }

      const lookup = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (req.method === "GET" && lookup) {
        if (bearer(req) !== internalToken) return send(res, 401, { error: "Gateway token required." });
        const session = SESSION_ID.test(lookup[1]) ? await store.get(lookup[1]) : null;
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
  if (typeof data.key_fingerprint !== "string" || !FINGERPRINT.test(data.key_fingerprint)) return "key_fingerprint must be sha256(sha256(gateway key)) in lowercase hex.";
  if (data.ticket !== null && (typeof data.ticket !== "string" || !TICKET.test(data.ticket))) return "ticket must be a ticket key (letters, digits, - and _) or null.";
  const text = (value, max) => (typeof value === "string" && value.length <= max ? value : null);
  return {
    session_id: data.session_id,
    key_fingerprint: data.key_fingerprint,
    ticket: data.ticket,
    branch: text(data.branch, 256),
    repo: text(data.repo, 256),
    event: text(data.event, 40) ?? "unknown",
    head: text(data.head, 64),
  };
}

/**
 * A fixed-window limit per key: `limit` writes per `windowMs`. Hooks report a
 * few times per session, so the default is generous for people and tight for
 * scripts.
 */
export function rateLimiter({ limit = 120, windowMs = 60_000, now = Date.now } = {}) {
  const windows = new Map();
  return (client) => {
    const t = now();
    const current = windows.get(client);
    if (!current || t - current.start >= windowMs) {
      if (windows.size > 50_000) {
        for (const [id, window] of windows) if (t - window.start >= windowMs) windows.delete(id);
      }
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
