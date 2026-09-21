/* Sync the database schema during the Vercel build.

   Production secrets are stored as Sensitive in Vercel, so they can't be pulled
   locally — but the build environment has them. Running the sync here is what
   keeps the deployed code and the database from drifting, which is exactly the
   failure that would otherwise ship code querying tables that don't exist yet.

   Safety properties this relies on:
   - `prisma db push` WITHOUT --accept-data-loss refuses any destructive change,
     so a schema edit that would drop data fails the build instead of running.
   - A failed build means Vercel keeps the previous deployment live. Deploys are
     atomic, so a refusal here is safe, not an outage.
   - DDL needs the session pooler (5432); the transaction pooler (6543) can't
     run it, so DIRECT_URL is preferred when present.

   Skips silently when no database is configured (e.g. a preview build without
   credentials) rather than failing the build for the wrong reason.

   On Render/Vercel these vars are already real process env vars by the time
   the build runs, so this worked in production without needing dotenv. But
   this script is invoked directly (`node scripts/deploy-migrate.mjs`), not
   through Next.js's own env loading — so a LOCAL `npm run build` never had
   .env's values available here at all, and this step silently no-opped on
   every local build with zero indication anything was skipped. Its sibling
   script in the same pipeline, ensure-guards.mjs, already self-loads dotenv
   as a fallback for exactly this reason; this one never got the same
   treatment, so the most important step in a pre-deploy build check — did
   the schema actually sync — was quietly doing nothing locally the whole
   time, a false-confidence trap for anyone treating a local `npm run build`
   as a real deploy verification. */
import { execSync } from "node:child_process";

try { (await import("dotenv")).config(); } catch { /* not installed: fine on Render/Vercel */ }

const url = process.env.DIRECT_URL || process.env.DATABASE_URL || "";

if (!url) {
  console.log("[deploy-migrate] No DATABASE_URL/DIRECT_URL — skipping schema sync.");
  process.exit(0);
}
if (!/^postgres(ql)?:\/\//.test(url)) {
  console.log("[deploy-migrate] Not a Postgres URL — skipping schema sync.");
  process.exit(0);
}

const host = (url.match(/@([^/?]+)/) || [])[1] || "unknown";
console.log(`[deploy-migrate] Syncing schema to ${host} …`);

/* The per-college reporting views (v_by_college_*, created by ensure-guards
   right after this step) depend on the tables, and Postgres refuses to drop or
   retype a column a view uses — which would fail `db push` on a future column
   change. Drop them first; ensure-guards recreates them a moment later.
   Best-effort: never blocks the deploy. */
try {
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: url.split("?")[0] });
  await c.connect();
  const schema = new URL(url).searchParams.get("schema") || "public";
  const { rows } = await c.query(
    `select table_name from information_schema.views where table_schema=$1 and table_name like 'v\_by\_college\_%'`, [schema]);
  for (const r of rows) await c.query(`DROP VIEW IF EXISTS "${schema}"."${r.table_name}"`);

  /* DayClose went from one row per date to one per (date, college) — each
     college has its own cash drawer. Prisma refuses to ADD a unique constraint
     without --accept-data-loss (it can't prove existing rows are unique), which
     would block every deploy. Existing rows are trivially unique on the wider
     key (collegeId defaults to ''), so apply this one migration as idempotent
     SQL here; `db push` then finds the database already in sync. */
  const [{ has }] = (await c.query(
    `select exists(select 1 from information_schema.tables where table_schema=$1 and table_name='DayClose') has`, [schema])).rows;
  if (has) {
    await c.query("BEGIN");
    await c.query(`ALTER TABLE "${schema}"."DayClose" ADD COLUMN IF NOT EXISTS "collegeId" TEXT NOT NULL DEFAULT ''`);
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS "DayClose_date_collegeId_key" ON "${schema}"."DayClose"("date","collegeId")`);
    await c.query(`ALTER TABLE "${schema}"."DayClose" DROP CONSTRAINT IF EXISTS "DayClose_date_key"`);
    await c.query(`DROP INDEX IF EXISTS "${schema}"."DayClose_date_key"`);
    await c.query("COMMIT");
  }
  await c.end();
  if (rows.length) console.log(`[deploy-migrate] Dropped ${rows.length} reporting view(s); ensure-guards recreates them.`);
} catch (e) {
  console.warn(`[deploy-migrate] view pre-drop skipped: ${e.message}`);
}

try {
  // Prisma 7 has no --skip-generate; --url is the supported override.
  execSync(`npx prisma db push --url "${url}"`, { stdio: "inherit" });
  console.log("[deploy-migrate] Schema in sync.");
} catch {
  console.error(
    "[deploy-migrate] Schema sync FAILED. The build stops here on purpose: shipping code " +
      "against a database that lacks its tables is worse than not shipping. The previous " +
      "deployment stays live.",
  );
  process.exit(1);
}
