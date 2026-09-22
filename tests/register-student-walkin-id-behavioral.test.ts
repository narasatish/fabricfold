/* Found live (owner, Sep 21): registering a new St Mary's student at the
   counter showed a random 6-digit id like "465456" instead of a real
   customer-facing code, because registerStudent only minted a bag for BVRIT
   and faculty students - every other student was left with NO bag row and no
   code at all, forever (customerIdFor's self-heal never fires for a
   never-had-a-bag student with no active plan either - it bails out and
   returns the same raw id). The "walkin" bag kind (W-series) already exists
   in lib/bagcode.ts for exactly this case; neither path used it. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.104" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_register_walkin_id";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let adminActions: typeof import("../lib/actions/admin");
let authLib: typeof import("../lib/auth");
let bagcode: typeof import("../lib/bagcode");

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
  adminActions = await import("../lib/actions/admin");
  authLib = await import("../lib/auth");
  bagcode = await import("../lib/bagcode");

  await db.college.create({ data: { id: "sm", name: "St Mary's", features: {} } });
}, 300_000);


async function signInAsStaff() {
  const st = await db.staff.findUniqueOrThrow({ where: { id: "stf1" } });
  await authLib.createSession({ mode: "staff", staffId: st.id, role: st.role, epoch: st.sessionEpoch });
}

describe("registering a plain student (no plan yet) issues a real customer ID", () => {
  it("registerStudent returns a W-series bagCode, not the raw internal id", async () => {
    await db.staff.create({ data: { id: "stf1", phone: "9000000090", name: "Counter", role: 1, collegeId: "sm" } });
    await signInAsStaff();
    const r = await adminActions.registerStudent({ name: "New Walk-in", phone: "9822200001", collegeId: "sm", kind: "student" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bagCode).not.toBeNull();
    expect(r.bagCode).toMatch(/^W\d+$/);
    expect(r.bagCode).not.toBe(r.id);
    const bag = await db.bag.findFirst({ where: { studentId: r.id, status: "active" } });
    expect(bag?.code).toBe(r.bagCode);
  });

  it("customerIdFor self-heals the same way for a student who somehow still has no bag (never a raw id)", async () => {
    const stu = await db.student.create({ data: { id: "hea001", phone: "9822200002", name: "Healed Kid", collegeId: "sm", kind: "student" } });
    const code = await bagcode.customerIdFor(db, stu, "St Mary's");
    expect(code).toMatch(/^W\d+$/);
    expect(code).not.toBe(stu.id);
  });
});
