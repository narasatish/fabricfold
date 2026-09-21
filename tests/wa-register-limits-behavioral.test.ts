/* Behavioral test (real action, real DB): BVRIT self-registration is a public
   front door. Found in the Sep 21 QA pass: it capped attempts at 10/hour per IP
   (a whole campus shares one WiFi address, so the 11th student on launch morning
   was refused) and had no limit on the name that goes straight onto the student. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.103" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_wa_register_limits";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;
process.env.WHATSAPP_BUSINESS_NUMBER = "919876543210";

let db: typeof import("../lib/db").db;
let reg: typeof import("../lib/actions/wa-register");

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

  db = (await import("../lib/db")).db;
  reg = await import("../lib/actions/wa-register");

  await db.college.create({ data: { id: "bv", name: "BVRIT", features: {} } });
}, 300_000);


const start = (name: string) => reg.startWhatsAppRegister({ name, collegeId: "bv" });

describe("startWhatsAppRegister name handling", () => {
  it("refuses an over-long name and writes nothing", async () => {
    const before = await db.waVerify.count();
    const r = await start("N".repeat(300));
    expect(r.ok).toBe(false);
    expect(await db.waVerify.count()).toBe(before);
  });
  it("strips control characters (a NUL byte would crash the write) and collapses whitespace", async () => {
    const nul = String.fromCharCode(0), bell = String.fromCharCode(7), nl = String.fromCharCode(10), tab = String.fromCharCode(9);
    const r = await start("Asha" + nul + "  Rao" + bell + nl + tab + "Kumar");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await db.waVerify.findUniqueOrThrow({ where: { code: r.code } });
    expect(row.studentName).toBe("Asha Rao Kumar");
  });
  it("still accepts a normal name, including non-Latin scripts", async () => {
    const r = await start("సతీష్ కుమార్");
    expect(r.ok).toBe(true);
  });
});

describe("launch-morning rate limit (one shared campus IP)", () => {
  it("allows well over 10 registrations an hour from the same address, then stops at the cap", async () => {
    let ok = 0, blocked = 0;
    for (let n = 0; n < 70; n++) { const r = await start("Student Number " + n); if (r.ok) ok++; else blocked++; }
    // the three tests above already used 2 slots from this IP
    expect(ok).toBeGreaterThanOrEqual(55);
    expect(blocked).toBeGreaterThanOrEqual(5);
  }, 240_000);
});
