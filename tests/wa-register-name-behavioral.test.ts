/* Behavioral test for a gap found 2026-09-11 (audit pass 11): checkWhatsAppRegister
   trusted a client-supplied `studentName` at claim time instead of the name
   captured server-side when the attempt began — inconsistent with how
   collegeId is deliberately locked at start. The registration code is shown
   on-screen while waiting for WhatsApp, so anyone with a moment's access to
   an unattended open tab could complete the registration under a name of
   their own choosing against someone else's verified phone number. Fixed by
   storing `studentName` on the WaVerify row at startWhatsAppRegister and
   ignoring whatever name (if any) is passed to checkWhatsAppRegister. */
import "dotenv/config";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.200" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-wa-register-name.db");
const SCHEMA = "ff_wa_register_name";
const TEST_URL = IS_PG ? BASE.split("?")[0] + `?schema=${SCHEMA}` : "file:" + TEST_DB;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let waRegister: typeof import("../lib/actions/wa-register");

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
  process.env.WHATSAPP_BUSINESS_NUMBER = "911234567890";
  db = (await import("../lib/db")).db;
  waRegister = await import("../lib/actions/wa-register");

  await db.college.create({ data: { id: "bvrit", name: "BVRIT", features: {} } });
}, 300_000);

describe.skipIf(!IS_PG)("WaVerify registration binds the name at attempt-start, not at claim", () => {
  it("checkWhatsAppRegister creates the account under the ORIGINAL name, ignoring a different name passed at claim time", async () => {
    const r = await waRegister.startWhatsAppRegister({ name: "Real Student", collegeId: "bvrit" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Simulate the webhook verifying the phone for this code.
    await db.waVerify.update({ where: { code: r.code }, data: { status: "verified", phone: "9876500099" } });

    // Same browser (same claim cookie still present) — an attacker with
    // access to the still-open tab tries to claim it under a DIFFERENT name.
    const claim = await waRegister.checkWhatsAppRegister(r.code);
    expect(claim.ok).toBe(true);
    if (!claim.ok || claim.status !== "registered") throw new Error("expected registration to succeed");

    const student = await db.student.findUnique({ where: { id: claim.studentId } });
    // The account must be created under the name captured at the START of
    // the attempt, never the name supplied at claim time.
    expect(student?.name).toBe("Real Student");
    expect(student?.name).not.toBe("Attacker Name");
  });
});
