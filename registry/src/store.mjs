/**
 * Storage for the registry. `sessions` holds the current ticket per session
 * (what the gateway reads); `session_events` keeps the timeline, so a ticket's
 * history can be explained later ("switched to ENG-8 at 14:02").
 */

export function memoryStore() {
  const sessions = new Map();
  const events = [];
  return {
    async get(id) {
      return sessions.get(id) ?? null;
    },
    async put(record) {
      sessions.set(record.session_id, { ...record, updated_at: new Date().toISOString() });
      events.push({ ...record, created_at: new Date().toISOString() });
    },
    events,
  };
}

export async function postgresStore(pool, { retentionDays = 90 } = {}) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tpt_sessions (
      session_id text PRIMARY KEY,
      ticket     text,
      branch     text,
      repo       text,
      key_fingerprint text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
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
  await migrate(pool);
  await pool.query(`DELETE FROM tpt_session_events WHERE created_at < now() - make_interval(days => $1)`, [retentionDays]);
  await pool.query(`DELETE FROM tpt_sessions WHERE updated_at < now() - make_interval(days => $1)`, [retentionDays]);

  return {
    async get(id) {
      const { rows } = await pool.query(
        "SELECT session_id, ticket, branch, repo, key_fingerprint, updated_at FROM tpt_sessions WHERE session_id = $1",
        [id],
      );
      return rows[0] ?? null;
    },
    async put(r) {
      await pool.query(
        `INSERT INTO tpt_sessions (session_id, ticket, branch, repo, key_fingerprint, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (session_id) DO UPDATE
           SET ticket = EXCLUDED.ticket, branch = EXCLUDED.branch, repo = EXCLUDED.repo, updated_at = now()
         WHERE tpt_sessions.key_fingerprint = EXCLUDED.key_fingerprint`,
        [r.session_id, r.ticket, r.branch, r.repo, r.key_fingerprint],
      );
      await pool.query(
        `INSERT INTO tpt_session_events (session_id, event, ticket, branch, repo, head)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [r.session_id, r.event, r.ticket, r.branch, r.repo, r.head],
      );
    },
  };
}

/**
 * Brings tables created by earlier versions up to date. Idempotent: every
 * step checks before it changes anything, so it runs on each start.
 *
 * v0.1 stored `key_token` (LiteLLM's sha256(key)). Sessions now store
 * `key_fingerprint` = sha256(key_token), which can be backfilled in SQL, so
 * existing sessions keep attributing after an upgrade.
 */
export async function migrate(pool) {
  await pool.query(`
    DO $$
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
    END $$;
  `);
}
