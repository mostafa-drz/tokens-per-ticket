/**
 * Storage for the registry.
 *
 * `tpt_sessions` holds the current ticket per session, and per subagent within
 * a session (`agent_id`, empty for the main conversation). That's what the
 * gateway reads. `tpt_session_events` keeps the timeline, so a ticket's history
 * can be explained later ("switched to ENG-8 at 14:02").
 */

const key = (sessionId, agentId = "") => `${sessionId}\n${agentId}`;

export function memoryStore() {
  const sessions = new Map();
  const events = [];
  return {
    async get(sessionId, agentId = "") {
      return sessions.get(key(sessionId, agentId)) ?? null;
    },
    async put(record) {
      sessions.set(key(record.session_id, record.agent_id), { ...record, updated_at: new Date().toISOString() });
      events.push({ ...record, created_at: new Date().toISOString() });
    },
    async prune() {},
    events,
  };
}

export async function postgresStore(pool, { retentionDays = 90 } = {}) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tpt_sessions (
      session_id      text NOT NULL,
      agent_id        text NOT NULL DEFAULT '',
      ticket          text,
      branch          text,
      repo            text,
      key_fingerprint text NOT NULL,
      updated_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS tpt_session_events (
      id         bigserial PRIMARY KEY,
      session_id text NOT NULL,
      agent_id   text NOT NULL DEFAULT '',
      event      text NOT NULL,
      ticket     text,
      branch     text,
      repo       text,
      head       text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS tpt_session_events_session ON tpt_session_events (session_id, created_at);
  `);
  await migrate(pool);

  const store = {
    async get(sessionId, agentId = "") {
      const { rows } = await pool.query(
        `SELECT session_id, agent_id, ticket, branch, repo, key_fingerprint, updated_at
           FROM tpt_sessions WHERE session_id = $1 AND agent_id = $2`,
        [sessionId, agentId],
      );
      return rows[0] ?? null;
    },
    async put(r) {
      await pool.query(
        `INSERT INTO tpt_sessions (session_id, agent_id, ticket, branch, repo, key_fingerprint, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (session_id, agent_id) DO UPDATE
           SET ticket = EXCLUDED.ticket, branch = EXCLUDED.branch, repo = EXCLUDED.repo, updated_at = now()
         WHERE tpt_sessions.key_fingerprint = EXCLUDED.key_fingerprint`,
        [r.session_id, r.agent_id ?? "", r.ticket, r.branch, r.repo, r.key_fingerprint],
      );
      await pool.query(
        `INSERT INTO tpt_session_events (session_id, agent_id, event, ticket, branch, repo, head)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [r.session_id, r.agent_id ?? "", r.event, r.ticket, r.branch, r.repo, r.head],
      );
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

/**
 * Brings tables created by earlier versions up to date. Idempotent: every
 * step checks before it changes anything, so it runs on each start.
 *
 * - v0.1 stored `key_token` (LiteLLM's sha256(key)). Sessions now store
 *   `key_fingerprint` = sha256(key_token), backfilled in SQL, so existing
 *   sessions keep attributing after an upgrade.
 * - Sessions were keyed by session_id alone; they are now keyed by
 *   (session_id, agent_id), with '' for the main conversation.
 */
export async function migrate(pool) {
  await pool.query(`
    DO $$
    DECLARE pk_name text;
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema() AND table_name = 'tpt_sessions' AND column_name = 'key_token') THEN
        ALTER TABLE tpt_sessions ADD COLUMN IF NOT EXISTS key_fingerprint text;
        UPDATE tpt_sessions
           SET key_fingerprint = encode(sha256(convert_to(key_token, 'UTF8')), 'hex')
         WHERE key_fingerprint IS NULL AND key_token IS NOT NULL;
        DELETE FROM tpt_sessions WHERE key_fingerprint IS NULL;
        ALTER TABLE tpt_sessions ALTER COLUMN key_fingerprint SET NOT NULL;
        ALTER TABLE tpt_sessions DROP COLUMN key_token;
      END IF;
      ALTER TABLE tpt_sessions DROP COLUMN IF EXISTS key_alias;
      ALTER TABLE tpt_session_events DROP COLUMN IF EXISTS key_alias;

      ALTER TABLE tpt_sessions ADD COLUMN IF NOT EXISTS agent_id text NOT NULL DEFAULT '';
      ALTER TABLE tpt_session_events ADD COLUMN IF NOT EXISTS agent_id text NOT NULL DEFAULT '';
      SELECT c.conname INTO pk_name
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE t.relname = 'tpt_sessions' AND n.nspname = current_schema() AND c.contype = 'p'
         AND array_length(c.conkey, 1) = 1;
      IF pk_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE tpt_sessions DROP CONSTRAINT %I', pk_name);
        ALTER TABLE tpt_sessions ADD PRIMARY KEY (session_id, agent_id);
      END IF;
    END $$;
  `);
}
