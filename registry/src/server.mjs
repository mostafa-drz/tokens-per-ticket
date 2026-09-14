import http from "node:http";

/**
 * The session registry: which ticket each Claude Code session is working on.
 *
 * Writers are Claude Code hooks on developer machines. They authenticate with
 * the developer's own gateway key, so there is no new credential to hand out.
 * The one reader is the gateway plugin (gateway/tokens_per_ticket.py), which
 * authenticates with a shared internal token and tags each model call.
 *
 *   POST /v1/sessions        Bearer <developer gateway key>   report a session's ticket
 *   GET  /v1/sessions/:id    Bearer <TPT_REGISTRY_TOKEN>      look one up (gateway only)
 *   GET  /healthz
 */

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_BODY_BYTES = 8 * 1024;

export function createServer({ store, validateKey, internalToken, log = () => {} }) {
  if (!internalToken) throw new Error("TPT_REGISTRY_TOKEN is required, so only the gateway can read sessions.");

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://registry");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });

      if (req.method === "POST" && url.pathname === "/v1/sessions") {
        const key = bearer(req);
        if (!key) return send(res, 401, { error: "Send your gateway key as Authorization: Bearer <key>." });
        const identity = await validateKey(key);
        if (!identity) return send(res, 401, { error: "The gateway does not recognize this key." });

        const report = parseReport(await readBody(req));
        if (typeof report === "string") return send(res, 400, { error: report });

        const existing = await store.get(report.session_id);
        if (existing && existing.key_token !== identity.token) {
          // A session belongs to the key that first reported it. Anyone else
          // re-pointing it would move a colleague's spend onto another ticket.
          return send(res, 403, { error: "This session was reported with a different key." });
        }
        await store.put({ ...report, key_token: identity.token, key_alias: identity.alias });
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
          key_token: session.key_token,
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
  if (data.ticket !== null && text(data.ticket, 64) === null) return "ticket must be a string of at most 64 characters, or null.";
  return {
    session_id: data.session_id,
    ticket: data.ticket,
    branch: text(data.branch, 256),
    repo: text(data.repo, 256),
    event: text(data.event, 40) ?? "unknown",
    head: text(data.head, 64),
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
