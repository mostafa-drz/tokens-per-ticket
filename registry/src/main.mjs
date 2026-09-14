import pg from "pg";
import { liteLLMKeyValidator } from "./litellm-auth.mjs";
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

const pool = new pg.Pool({ connectionString: required("DATABASE_URL"), max: 5 });
const store = await postgresStore(pool, { retentionDays: Number(process.env.TPT_RETENTION_DAYS ?? 90) });
const server = createServer({
  store,
  validateKey: liteLLMKeyValidator({ baseUrl: required("LITELLM_URL") }),
  internalToken: required("TPT_REGISTRY_TOKEN"),
  log: (line) => console.log(`registry: ${line}`),
});

const port = Number(process.env.PORT ?? 4100);
server.listen(port, () => console.log(`registry: listening on :${port}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => pool.end().then(() => process.exit(0))));
}
