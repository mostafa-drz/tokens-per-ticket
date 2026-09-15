import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

/**
 * The session registry: which ticket each Claude Code session is working on.
 *
 * Writers are Claude Code hooks on developer machines. They authenticate with
 * the developer's own LiteLLM virtual key, so serve it over HTTPS. The
 * registry keeps only sha256(key), the form
 * LiteLLM stores, accepts only active virtual keys, and gives a session to the
 * key that first reported it. The gateway plugin tags a call only when the
 * calling key owns the session, so a report can only attribute its own calls.
 *
 * Subagents share their session's id and count toward its ticket: Claude Code
 * sends `agent_id` to hooks only on tool events, which these hooks don't use.
 *
 * The one reader is the gateway plugin (gateway/tokens_per_ticket.py), with a
 * shared internal token.
 *
 *   POST /v1/sessions        Bearer <virtual key>          report a session's ticket
 *   GET  /v1/sessions/:id    Bearer <TPT_REGISTRY_TOKEN>   look one up (gateway only)
 *   GET  /healthz
 */

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TICKET = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY_BYTES = 8 * 1024;

export function createServer({ store, internalToken, log = () => {}, limiter = rateLimiter() }) {
  if (!internalToken) throw new Error("TPT_REGISTRY_TOKEN is required, so only the gateway can read sessions.");

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://registry");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });

      if (req.method === "POST" && url.pathname === "/v1/sessions") {
        const key = bearer(req);
        // LiteLLM virtual keys start with sk-; anything else is refused before touching the database.
        if (!key?.startsWith("sk-")) return send(res, 401, { error: "Send your LiteLLM virtual key as Authorization: Bearer <key>." });
        const keyToken = createHash("sha256").update(key).digest("hex");
        if (!(await store.isActiveToken(keyToken))) {
          return send(res, 401, { error: "This key isn't an active LiteLLM virtual key (the master key can't be attributed)." });
        }
        if (!limiter(keyToken)) return send(res, 429, { error: "Too many reports for this key. Slow down." });
        const report = parseReport(await readBody(req));
        if (typeof report === "string") return send(res, 400, { error: report });
        if (!(await store.put({ ...report, key_token: keyToken }))) {
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
        if (!sameSecret(bearer(req), internalToken)) return send(res, 401, { error: "Gateway token required." });
        const session = SESSION_ID.test(lookup[1]) ? await store.get(lookup[1]) : null;
        if (!session) return send(res, 404, { error: "Unknown session." });
        return send(res, 200, { ticket: session.ticket, key_token: session.key_token });
      }

      send(res, 404, { error: "Not found." });
    } catch (error) {
      log(`error: ${error instanceof Error ? error.message : String(error)}`);
      if (res.headersSent) return;
      // "LiteLLM_VerificationToken" doesn't exist until LiteLLM's first start finishes.
      if (error?.code === "42P01") return send(res, 503, { error: "LiteLLM hasn't created its tables yet. Try again shortly." });
      send(res, 500, { error: "Registry error." });
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
  if (data.ticket !== null && (typeof data.ticket !== "string" || !TICKET.test(data.ticket))) return "ticket must be a ticket key (letters, digits, - and _) or null.";
  const text = (value, max) => (typeof value === "string" && value.length <= max ? value : null);
  return {
    session_id: data.session_id,
    // Tags are case-sensitive; keep one spelling per ticket.
    ticket: data.ticket === null ? null : data.ticket.toUpperCase(),
    event: text(data.event, 40) ?? "unknown",
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

function sameSecret(given, expected) {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
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
