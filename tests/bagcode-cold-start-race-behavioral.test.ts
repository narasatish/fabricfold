/* allocateBagCode's FySequence cold-start race, exercised for REAL against a
   real Postgres database — not the fast fakeTx-mocked tests in
   bagcode-recycle.test.ts, which can't exercise true concurrency.

   Found 2026-10-20 in a deep audit: the FIRST-EVER mint for a given letter
   used to be a plain find-then-create — `findUnique`, then (if null)
   `create`. Two concurrent first mints for the SAME letter both see no row,
   both attempt `create`, and the loser gets an unhandled P2002. Narrow in
   the app's lifetime under the old single shared-row scheme (this could only
   ever happen once, ever) — but today's rewrite to five independent
   per-letter rows means all five are freshly cold at once, right at this
   deploy. Fixed with a single atomic `INSERT ... ON CONFLICT DO UPDATE`. */
import "dotenv/config";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.95" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_bagcode_cold_start_race";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let allocateBagCode: typeof import("../lib/bagcode").allocateBagCode;
let parseBagCode: typeof import("../lib/bagcode").parseBagCode;

beforeAll(async () => {
  const { Client } = await import("pg");
  const admin = new Client({ connectionString: BASE.split("?")[0] });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await admin.end();
  execSync("npx prisma db push", {
    cwd: path.resolve(__dirname, ".."), stdio: "ignore",
    env: { ...process.env, DATABASE_URL: TEST_URL },
  });
  ({ db } = await import("../lib/db"));
  ({ allocateBagCode, parseBagCode } = await import("../lib/bagcode"));
}, 300_000);

describe("allocateBagCode's FySequence row can't be double-created by two concurrent FIRST mints for the same letter", () => {
  it("two simultaneous first-ever BVRIT mints both get a code, never crash, and never collide", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => db.$transaction((tx) => allocateBagCode(tx, "bvrit"))),
    );
    // None may throw (an unhandled P2002 from the old find-then-create race
    // would surface as a rejected promise here, failing Promise.all).
    expect(results).toHaveLength(5);
    // Every code is for the "V" letter and a distinct number — no two
    // concurrent first mints may land on the same number.
    const parsed = results.map((c) => parseBagCode(c)!);
    expect(parsed.every((p) => p.kind === "bvrit")).toBe(true);
    const numbers = parsed.map((p) => p.n);
    expect(new Set(numbers).size).toBe(5); // all distinct
    expect(Math.min(...numbers)).toBe(1001); // starts exactly at MINT_FROM+1

    const row = await db.fySequence.findUniqueOrThrow({ where: { kind_fyTag: { kind: "bagcode", fyTag: "V" } } });
    expect(row.value).toBe(1005); // exactly 5 increments, none lost to the race
  });
});
