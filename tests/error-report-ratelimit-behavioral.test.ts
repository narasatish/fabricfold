/* Behavioral test (real route handler invocation against a real test DB) for
   a gap found 2026-09-05: app/api/error/route.ts is a PUBLIC, unauthenticated
   endpoint (client error boundaries report from pages where nobody may be
   signed in, e.g. /login) with no rate limit at all. Its per-message email
   dedup ("at most one owner email per distinct message per hour") does
   nothing against an attacker varying the message text slightly on every
   call — that bypasses the dedup entirely and can trigger unlimited
   notifyOwner() emails, or just bloat ErrorLog without bound. Fixed with the
   same per-IP rateLimit() cap already used elsewhere in this codebase
   (requestOtp, loginWithPasscode). */
import "dotenv/config";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const FIXED_IP = "203.0.113.84";
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers({ "x-forwarded-for": FIXED_IP }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-error-report-ratelimit.db");
const SCHEMA = "ff_error_report_ratelimit";
const TEST_URL = IS_PG ? BASE.split("?")[0] + `?schema=${SCHEMA}` : "file:" + TEST_DB;
process.env.DATABASE_URL = TEST_URL;

let POST: (req: Request) => Promise<Response>;

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
  // Clear the globalThis singleton cache so modules imported next will get
  // a fresh db client with the test schema, not an old cached one
  const g = globalThis as unknown as { __ffdb?: unknown };
  delete g.__ffdb;
  const mod = await import("../app/api/error/route");
  POST = mod.POST;
}, 300_000);

const post = (message: string) =>
  POST(new Request("https://fabricfold.in/api/error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, kind: "client" }),
  }));

describe("the public error-report endpoint is rate-limited per IP", () => {
  it("caps distinct-message reports from one IP, even though each message is individually unique (dodging the email dedup)", async () => {
    const results: number[] = [];
    for (let i = 0; i < 65; i++) {
      const res = await post(`Synthetic error #${i} — ${Math.random()}`);
      results.push(res.status);
    }
    const capped = results.filter((s) => s === 429);
    const accepted = results.filter((s) => s === 200);
    expect(accepted.length).toBe(60);
    expect(capped.length).toBe(5);
  }, 120_000);
});

