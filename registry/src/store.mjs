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
      key_token  text NOT NULL,
      key_alias  text,
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
      key_alias  text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS tpt_session_events_session ON tpt_session_events (session_id, created_at);
  `);
  await pool.query(`DELETE FROM tpt_session_events WHERE created_at < now() - make_interval(days => $1)`, [retentionDays]);
  await pool.query(`DELETE FROM tpt_sessions WHERE updated_at < now() - make_interval(days => $1)`, [retentionDays]);

  return {
    async get(id) {
      const { rows } = await pool.query(
        "SELECT session_id, ticket, branch, repo, key_token, key_alias, updated_at FROM tpt_sessions WHERE session_id = $1",
        [id],
      );
      return rows[0] ?? null;
    },
    async put(r) {
      await pool.query(
        `INSERT INTO tpt_sessions (session_id, ticket, branch, repo, key_token, key_alias, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (session_id) DO UPDATE
           SET ticket = EXCLUDED.ticket, branch = EXCLUDED.branch, repo = EXCLUDED.repo,
               key_alias = EXCLUDED.key_alias, updated_at = now()`,
        [r.session_id, r.ticket, r.branch, r.repo, r.key_token, r.key_alias],
      );
      await pool.query(
        `INSERT INTO tpt_session_events (session_id, event, ticket, branch, repo, head, key_alias)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [r.session_id, r.event, r.ticket, r.branch, r.repo, r.head, r.key_alias],
      );
    },
  };
}
