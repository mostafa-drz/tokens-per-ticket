/**
 * Storage for the registry: the current ticket per Claude Code session, in
 * LiteLLM's Postgres (its own schema), which also lets the registry check keys
 * against LiteLLM's key table.
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

/**
 * The registry's table lives in its own schema, never in LiteLLM's "public":
 * on upgrade, LiteLLM diffs "public" against its Prisma schema and applies the
 * result, which drops tables it doesn't know
 * (litellm_proxy_extras/utils.py, _resolve_all_migrations, v1.100.1).
 */
export async function postgresStore(pool, { schema = "tpt", retentionDays = 90, cacheMs = 10_000 } = {}) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Invalid schema name: ${schema}`);
  const TABLE = `${schema}.sessions`;
  const DDL = `
    CREATE SCHEMA IF NOT EXISTS ${schema};
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      session_id text PRIMARY KEY,
      ticket     text,
      key_token  text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `;

  // DDL only when the table is missing, so a role without CREATE can run an
  // already set up registry.
  async function ensureTable() {
    const { rows } = await pool.query(`SELECT to_regclass('${TABLE}') AS t`);
    if (!rows[0].t) await pool.query(DDL);
  }
  // If the table disappears anyway, recreate it and retry once.
  async function query(text, values) {
    try {
      return await pool.query(text, values);
    } catch (error) {
      if (error?.code !== "42P01") throw error;
      await ensureTable();
      return pool.query(text, values);
    }
  }
  await ensureTable();

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
      const { rows } = await query(`SELECT session_id, ticket, key_token, updated_at FROM ${TABLE} WHERE session_id = $1`, [sessionId]);
      return rows[0] ?? null;
    },
    /** Upserts the session; false when another key already owns it. */
    async put(r) {
      const { rowCount } = await query(
        `INSERT INTO ${TABLE} AS s (session_id, ticket, key_token, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (session_id) DO UPDATE
           SET ticket = EXCLUDED.ticket, updated_at = now()
         WHERE s.key_token = EXCLUDED.key_token
         RETURNING session_id`,
        [r.session_id, r.ticket, r.key_token],
      );
      return rowCount > 0;
    },
    /** Deletes sessions not updated within the retention window. */
    async prune() {
      await query(`DELETE FROM ${TABLE} WHERE updated_at < now() - make_interval(days => $1)`, [retentionDays]);
    },
  };
  // Cleanup is housekeeping: a role without DELETE shouldn't stop the registry.
  await store.prune().catch((error) => console.error(`registry: prune failed: ${error.message}`));
  return store;
}
