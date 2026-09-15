/**
 * Storage for the registry: the current ticket per Claude Code session, in
 * LiteLLM's own Postgres, which also lets the registry check keys against
 * LiteLLM's key table.
 */

export function memoryStore({ tokens = null } = {}) {
  const sessions = new Map();
  return {
    async isActiveToken(token) {
      return tokens ? tokens.has(token) : true;
    },
    async get(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    async put(record) {
      const existing = sessions.get(record.session_id);
      if (existing && existing.key_token !== record.key_token) return false;
      sessions.set(record.session_id, { ...record, updated_at: new Date().toISOString() });
      return true;
    },
    async prune() {},
    sessions,
  };
}

export async function postgresStore(pool, { retentionDays = 90, cacheMs = 60_000 } = {}) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tpt_sessions (
      session_id text PRIMARY KEY,
      ticket     text,
      branch     text,
      repo       text,
      key_token  text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const tokenCache = new Map();

  const store = {
    /**
     * True when `token` (sha256 of a virtual key, as LiteLLM stores it) is an
     * active key in "LiteLLM_VerificationToken". Looked up by primary key and
     * cached briefly, so a flood of unknown keys costs index lookups, not scans.
     */
    async isActiveToken(token) {
      const hit = tokenCache.get(token);
      if (hit && hit.expires > Date.now()) return hit.active;
      const { rows } = await pool.query(
        `SELECT 1 FROM "LiteLLM_VerificationToken"
          WHERE token = $1 AND (blocked IS NOT TRUE) AND (expires IS NULL OR expires > now())`,
        [token],
      );
      const active = rows.length > 0;
      if (tokenCache.size > 10_000) tokenCache.clear();
      tokenCache.set(token, { active, expires: Date.now() + (active ? cacheMs : cacheMs / 2) });
      return active;
    },
    async get(sessionId) {
      const { rows } = await pool.query(
        "SELECT session_id, ticket, branch, repo, key_token, updated_at FROM tpt_sessions WHERE session_id = $1",
        [sessionId],
      );
      return rows[0] ?? null;
    },
    /** Upserts the session; false when another key already owns it. */
    async put(r) {
      const { rowCount } = await pool.query(
        `INSERT INTO tpt_sessions (session_id, ticket, branch, repo, key_token, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (session_id) DO UPDATE
           SET ticket = EXCLUDED.ticket, branch = EXCLUDED.branch, repo = EXCLUDED.repo, updated_at = now()
         WHERE tpt_sessions.key_token = EXCLUDED.key_token
         RETURNING session_id`,
        [r.session_id, r.ticket, r.branch, r.repo, r.key_token],
      );
      return rowCount > 0;
    },
    /** Deletes sessions not updated within the retention window. */
    async prune() {
      await pool.query(`DELETE FROM tpt_sessions WHERE updated_at < now() - make_interval(days => $1)`, [retentionDays]);
    },
  };
  await store.prune();
  return store;
}
