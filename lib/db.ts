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
