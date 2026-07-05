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
    return new PrismaPg({ connectionString: url });
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");
  return new PrismaBetterSqlite3({ url });
}

// Singleton across Next.js hot reloads.
const g = globalThis as unknown as { __ffdb?: PrismaClient };

export const db = g.__ffdb ?? new PrismaClient({ adapter: makeAdapter() });

if (process.env.NODE_ENV !== "production") g.__ffdb = db;
