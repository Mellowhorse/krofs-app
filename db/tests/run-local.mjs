// Local CI reproduction — runs the exact migration chain from .github/workflows/
// ci.yml against a throwaway real Postgres (via embedded-postgres, no Docker),
// stopping at the first error with its message/position. Use this to pre-flight
// a new migration before pushing (this machine has no local psql/docker).
//
//   cd db/tests && npm install && npm test
//
// Keep FILES below in sync with ci.yml's apply order.
import EmbeddedPostgres from "embedded-postgres";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const FILES = [
  "db/tests/ci_stubs.sql",
  "db/001_initial_schema.sql",
  "db/002_reconcile.sql",
  "db/003_product_improvements.sql",
  "db/004_security_hardening.sql",
  "db/005_painter_rpcs.sql",
  "db/006_round_dispatch.sql",
  "db/007_outbox.sql",
  "db/008_geocode.sql",
  "db/009_route_clustering.sql",
  "db/010_public_intake.sql",
  "db/seed_dev.sql",
  "db/tests/smoke_test.sql",
];

const pg = new EmbeddedPostgres({
  databaseDir: "./pgdata",
  user: "postgres",
  password: "postgres",
  port: 5459,
  persistent: false,
});

await pg.initialise();
await pg.start();
const client = pg.getPgClient();
await client.connect();
console.log("Postgres", (await client.query("show server_version")).rows[0].server_version);

let failed = false;
for (const f of FILES) {
  try {
    await client.query(readFileSync(`${REPO}/${f}`, "utf8"));
    console.log("OK  ", f);
  } catch (e) {
    console.log("FAIL", f);
    for (const k of ["message", "position", "where", "detail", "hint"]) {
      if (e[k]) console.log(`  ${k}:`, e[k]);
    }
    failed = true;
    break;
  }
}

await client.end();
await pg.stop();
console.log(failed ? "\n=== CHAIN FAILED ===" : "\n=== CHAIN GREEN ===");
process.exit(failed ? 1 : 0);
