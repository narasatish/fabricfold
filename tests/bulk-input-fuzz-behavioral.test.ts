/* Behavioral fuzz (real actions, real test DB) for staff-typed lists.
   Found in the Sep 21 testing pass: bulkRegisterStudents accepted any 10
   digits (0000000000, 1234567890 - numbers that can never receive a WhatsApp
   message) and unlimited-length names; broadcastNotice had no length cap and
   would write a huge message into every student's notifications. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.98" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_bulk_fuzz";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let students: typeof import("../lib/actions/students");

beforeAll(async () => {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: BASE.split("?")[0] });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await c.end();
  execSync("npx prisma db push", { cwd: path.resolve(__dirname, ".."), stdio: "ignore", env: { ...process.env, DATABASE_URL: TEST_URL } });
  db = (await import("../lib/db")).db;
  students = await import("../lib/actions/students");
  const authLib = await import("../lib/auth");
  await db.college.create({ data: { id: "col1", name: "Fuzz College", features: {} } });
  await db.staff.create({ data: { id: "adm1", phone: "9000000020", name: "Admin", role: 3, active: true, collegeId: "col1" } });
  await authLib.createSession({ mode: "staff", staffId: "adm1", role: 3, epoch: 0 });
}, 300_000);

const bulk = (text: string) => students.bulkRegisterStudents(text, "col1");

describe("bulkRegisterStudents", () => {
  it("skips numbers that can't be real mobiles and keeps the valid ones", async () => {
    const r = await bulk("Asha Rao, 9876543210\nZero Man, 0000000000\nOne Two, 1234567890\nMeera, 8123456789");
    expect(r.ok && r.created).toBe(2);
    expect(r.ok && r.skipped.map((x) => x.reason)).toEqual(["no valid 10-digit phone", "no valid 10-digit phone"]);
    expect(await db.student.count({ where: { phone: { in: ["0000000000", "1234567890"] } } })).toBe(0);
  });
  it("caps an over-long name instead of storing it whole", async () => {
    await bulk("N".repeat(400) + ", 9700000001");
    const s = await db.student.findUniqueOrThrow({ where: { phone: "9700000001" } });
    expect(s.name.length).toBeLessThanOrEqual(80);
  });
});

describe("broadcastNotice", () => {
  it("refuses a huge message and writes nothing", async () => {
    const before = await db.notification.count();
    const r = await students.broadcastNotice("col1", "x".repeat(100_000));
    expect(r.ok).toBe(false);
    expect(await db.notification.count()).toBe(before);
  });
  it("still sends a normal notice", async () => {
    expect((await students.broadcastNotice("col1", "Laundry closed Thursday")).ok).toBe(true);
  });
});
