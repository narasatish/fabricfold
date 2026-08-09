import "dotenv/config";
import { Client } from "pg";
async function main() {
  const base = (process.env.DIRECT_URL || "").split("?")[0];
  const c = new Client({ connectionString: base }); await c.connect();
  for (const sch of ["public", "ff_restore_test"]) {
    try {
      const r = await c.query(`select
        (select count(*) from ${sch}."Student")::int s,
        (select count(*) from ${sch}."College")::int c,
        (select count(*) from ${sch}."AuditLog")::int a`);
      console.log(sch.padEnd(18), `students=${r.rows[0].s} colleges=${r.rows[0].c} auditLog=${r.rows[0].a}`);
    } catch (e) { console.log(sch.padEnd(18), (e as Error).message.slice(0, 50)); }
  }
  await c.end();
}
main().catch((e) => console.error(e.message));
