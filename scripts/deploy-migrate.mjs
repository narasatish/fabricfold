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
