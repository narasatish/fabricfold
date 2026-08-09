/* Drop a scratch schema. Refuses `public` — this exists to clean up restore
   tests, not to destroy a database. */
import "dotenv/config";
import { Client } from "pg";

async function main() {
  const target = process.argv[2];
  if (!target || target === "public") {
    console.error("Refusing: pass a non-public schema name.");
    process.exit(1);
  }
  const c = new Client({ connectionString: (process.env.DIRECT_URL || "").split("?")[0] });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS "${target}" CASCADE`);
  console.log(`dropped schema ${target}`);
  await c.end();
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
