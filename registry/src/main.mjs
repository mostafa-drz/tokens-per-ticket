import pg from "pg";
import { createServer } from "./server.mjs";
import { postgresStore } from "./store.mjs";

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`registry: ${name} is required`);
    process.exit(1);
  }
  return value;
};

const pool = new pg.Pool({
  connectionString: required("DATABASE_URL"),
  max: 5,
  connectionTimeoutMillis: 2_000,
  statement_timeout: 2_000,
});
// An idle client that loses its connection (Postgres restart, failover, idle
// timeout) emits 'error' on the pool; unhandled, that exits the process.
// https://node-postgres.com/apis/pool#error
pool.on("error", (error) => console.error(`registry: database connection lost: ${error.message}`));
const store = await postgresStore(pool, { retentionDays: Number(process.env.TPT_RETENTION_DAYS ?? 90) });
const server = createServer({
  store,
  internalToken: required("TPT_REGISTRY_TOKEN"),
  log: (line) => console.log(`registry: ${line}`),
});

// Retention runs at start and then every six hours.
setInterval(() => store.prune().catch((error) => console.error(`registry: prune failed: ${error.message}`)), 6 * 3600_000).unref();

const port = Number(process.env.PORT ?? 4100);
server.listen(port, () => console.log(`registry: listening on :${port}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => pool.end().then(() => process.exit(0))));
}
