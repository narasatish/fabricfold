/* Behavioral test for a gap found 2026-09-17: app/api/error/route.ts is a
   PUBLIC, unauthenticated endpoint, and `kind` used to come straight from the
   client-submitted body — a caller claiming kind:"server" was trusted as
   such. Every REAL caller (components/error-reporter.tsx) always sends
   kind:"client"; a genuine server-side error is logged directly via
   db.errorLog.create() from trusted server code, never through this HTTP
   route. That distinction now matters more than it used to: the fast
   watchdog (app/api/cron/watchdog/route.ts) alerts the Owner immediately on
   any unseen kind:"server" row, so trusting the client here let anyone spam
   urgent "production is broken" alerts from a session-less endpoint. Fixed
   by forcing kind:"client" unconditionally, regardless of what the caller
   sends. Isolated in its own file (own IP, own rate-limit bucket) since
   error-report-ratelimit-behavioral.test.ts already exhausts its shared
   mocked IP's budget. */
import "dotenv/config";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const FIXED_IP = "203.0.113.85"; // distinct from error-report-ratelimit-behavioral.test.ts's IP
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers({ "x-forwarded-for": FIXED_IP }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-error-report-kind-spoof.db");
const SCHEMA = "ff_error_report_kind_spoof";
const TEST_URL = IS_PG ? BASE.split("?")[0] + `?schema=${SCHEMA}` : "file:" + TEST_DB;
process.env.DATABASE_URL = TEST_URL;

let POST: (req: Request) => Promise<Response>;
let db: typeof import("../lib/db").db;

beforeAll(async () => {
  if (IS_PG) {
    const { Client } = await import("pg");
    const c = new Client({ connectionString: BASE.split("?")[0] });
    await c.connect();
    await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
    await c.end();
    execSync("npx prisma db push", { cwd: path.resolve(__dirname, ".."), stdio: "ignore", env: { ...process.env, DATABASE_URL: TEST_URL } });
  } else {
    if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB);
    execSync(`npx prisma db push --url "file:${TEST_DB}"`, { cwd: path.resolve(__dirname, ".."), stdio: "ignore" });
  }
  const g = globalThis as unknown as { __ffdb?: unknown };
  delete g.__ffdb;
  db = (await import("../lib/db")).db;
  const mod = await import("../app/api/error/route");
  POST = mod.POST;
}, 300_000);

describe("kind cannot be spoofed by the caller", () => {
  it("a caller claiming kind:\"server\" is still logged as kind:\"client\"", async () => {
    const res = await POST(new Request("https://fabricfold.in/api/error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "spoof attempt", kind: "server" }),
    }));
    expect(res.status).toBe(200);

    const rows = await db.errorLog.findMany({ where: { message: "spoof attempt" } });
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("client");
  });

  it("a normal client report still logs kind:\"client\" as before", async () => {
    await POST(new Request("https://fabricfold.in/api/error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "ordinary client error", kind: "client" }),
    }));
    const rows = await db.errorLog.findMany({ where: { message: "ordinary client error" } });
    expect(rows[0].kind).toBe("client");
  });
});
