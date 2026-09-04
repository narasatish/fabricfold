import "dotenv/config";
import { PrismaClient } from "./generated/prisma/client";

// Pick the driver adapter from the connection string:
//   postgres[ql]://…  → Supabase / any Postgres (production)
//   file:…            → local SQLite (dev & tests)
// This lets the same code run locally on SQLite and in the cloud on Postgres.
const url = process.env.DATABASE_URL || "file:./dev.db";

function makeAdapter() {
  if (/^postgres(ql)?:\/\//.test(url)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaPg } = require("@prisma/adapter-pg");
    // Honour ?schema=… so an isolated schema (e.g. tests) is actually used at runtime.
    const schema = new URL(url).searchParams.get("schema") || undefined;
    // Cap connections so a serverless instance never exhausts Supabase's pooler.
    // The transaction pooler (port 6543) releases each connection after a query,
    // so a small client pool is plenty and safe under concurrency. Overridable
    // via DB_POOL_MAX for load-testing against a host without that pooler
    // (e.g. Render's direct Postgres) — production default stays 4.
    const max = Number(process.env.DB_POOL_MAX) || 4;
    return new PrismaPg(
      { connectionString: url, max, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 15_000 },
      schema ? { schema } : undefined,
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");
  return new PrismaBetterSqlite3({ url });
}

// Singleton across Next.js hot reloads.
const g = globalThis as unknown as { __ffdb?: PrismaClient };

export const db = g.__ffdb ?? new PrismaClient({ adapter: makeAdapter() });

if (process.env.NODE_ENV !== "production") g.__ffdb = db;

/**
 * The ?schema=… param above scopes every Prisma-generated ORM query to a
 * non-default schema (tests use ff_test, a few dev sandboxes use their own).
 * Raw SQL ($queryRaw/$executeRaw) does NOT pick that up automatically — it
 * runs against whatever the connection's default search_path is, which is
 * "public" unless told otherwise. Two raw-SQL call sites (rate-limit.ts,
 * sheet-events.ts) found this out the hard way: their writes landed in
 * public."RateLimit" while the tests around them cleaned up ff_test's copy,
 * so a stray public-schema row from a completely unrelated run silently
 * exhausted the rate limit for every test in the file. Prefix any raw
 * table reference with this (via Prisma.raw, since it's config-derived,
 * never user input) to keep raw SQL scoped the same as everything else.
 */
export const dbSchemaPrefix = (() => {
  const schema = /^postgres(ql)?:\/\//.test(url) ? new URL(url).searchParams.get("schema") : null;
  return schema ? `"${schema}".` : "";
})();
