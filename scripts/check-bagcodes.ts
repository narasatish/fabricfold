/* Where have bag codes actually been burned? `public` is the live sequence that
   maps to printed labels; ff_test is the throwaway one the QA scripts use. */
import "dotenv/config";
import { Client } from "pg";

async function main() {
  const base = (process.env.DIRECT_URL || process.env.DATABASE_URL || "").split("?")[0];
  console.log("host:", (base.match(/@([^/?]+)/) || [])[1] || "unknown");
  const c = new Client({ connectionString: base });
  await c.connect();
  for (const sch of ["public", "ff_test"]) {
    try {
      const r = await c.query(
        `select kind, "fyTag", value from ${sch}."FySequence" where kind = 'bagcode' order by "fyTag"`,
      );
      console.log(sch.padEnd(8), r.rows.length ? JSON.stringify(r.rows) : "(no bagcode rows)");
    } catch {
      console.log(sch.padEnd(8), "schema/table not present");
    }
  }
  await c.end();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
