/**
 * Storage for the registry.
 *
 * `tpt_sessions` holds the current ticket per Claude Code session (what the
 * gateway reads). `tpt_session_events` keeps the timeline, so a ticket's history
 * can be explained later ("switched to ENG-8 at 14:02"). Both live in LiteLLM's
 * own Postgres, which also lets the registry accept reports only for real keys.
 */

export function memoryStore({ fingerprints = null } = {}) {
  const sessions = new Map();
  const events = [];
  return {
    async isKnownFingerprint(fingerprint) {
      return fingerprints ? fingerprints.has(fingerprint) : true;
    },
    async get(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    async put(record) {
      const existing = sessions.get(record.session_id);
      if (existing && existing.key_fingerprint !== record.key_fingerprint) return false;
      sessions.set(record.session_id, { ...record, updated_at: new Date().toISOString() });
      events.push({ ...record, created_at: new Date().toISOString() });
      return true;
    },
    async prune() {},
    events,
  };
}

export async function postgresStore(pool, { retentionDays = 90, fingerprintCacheMs = 60_000 } = {}) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tpt_sessions (
      session_id      text PRIMARY KEY,
      ticket          text,
      branch          text,
      repo            text,
      key_fingerprint text NOT NULL,
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS tpt_session_events (
      id         bigserial PRIMARY KEY,
      session_id text NOT NULL,
      event      text NOT NULL,
      ticket     text,
      branch     text,
      repo       text,
      head       text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS tpt_session_events_session ON tpt_session_events (session_id, created_at);
  `);

  let known = { at: 0, set: new Set() };

  const store = {
    /**
     * True when the fingerprint belongs to an active LiteLLM virtual key.
     * LiteLLM stores keys as sha256(key) in "LiteLLM_VerificationToken".token,
     * so sha256(token) is the fingerprint hooks send. The master key isn't in
     * that table, and its calls can't be attributed either.
     */
    async isKnownFingerprint(fingerprint) {
      if (Date.now() - known.at > fingerprintCacheMs || !known.set.has(fingerprint)) {
        const { rows } = await pool.query(
          `SELECT encode(sha256(convert_to(token, 'UTF8')), 'hex') AS fingerprint
             FROM "LiteLLM_VerificationToken"
            WHERE (blocked IS NOT TRUE) AND (expires IS NULL OR expires > now())`,
        );
        known = { at: Date.now(), set: new Set(rows.map((row) => row.fingerprint)) };
      }
      return known.set.has(fingerprint);
    },
    async get(sessionId) {
      const { rows } = await pool.query(
        "SELECT session_id, ticket, branch, repo, key_fingerprint, updated_at FROM tpt_sessions WHERE session_id = $1",
        [sessionId],
      );
      return rows[0] ?? null;
    },
    /** Upserts the session; false when another key already owns it. */
    async put(r) {
      const { rowCount } = await pool.query(
        `INSERT INTO tpt_sessions (session_id, ticket, branch, repo, key_fingerprint, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (session_id) DO UPDATE
           SET ticket = EXCLUDED.ticket, branch = EXCLUDED.branch, repo = EXCLUDED.repo, updated_at = now()
         WHERE tpt_sessions.key_fingerprint = EXCLUDED.key_fingerprint
         RETURNING session_id`,
        [r.session_id, r.ticket, r.branch, r.repo, r.key_fingerprint],
      );
      if (rowCount === 0) return false;
      await pool.query(
        `INSERT INTO tpt_session_events (session_id, event, ticket, branch, repo, head) VALUES ($1, $2, $3, $4, $5, $6)`,
        [r.session_id, r.event, r.ticket, r.branch, r.repo, r.head],
      );
      return true;
    },
    /** Deletes sessions and events older than the retention window. */
    async prune() {
      await pool.query(`DELETE FROM tpt_session_events WHERE created_at < now() - make_interval(days => $1)`, [retentionDays]);
      await pool.query(`DELETE FROM tpt_sessions WHERE updated_at < now() - make_interval(days => $1)`, [retentionDays]);
    },
  };
  await store.prune();
  return store;
}
