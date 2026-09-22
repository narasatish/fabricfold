/* Found live (owner, Sep 21): registering a new St Mary's student at the
   counter showed a random 6-digit id like "465456" instead of a real
   customer-facing code, because registerStudent only minted a bag for BVRIT
   and faculty students - every other student was left with NO bag row and no
   code at all, forever (customerIdFor's self-heal had the same gap). Owner,
   Sep 22: "for bvrit ... only V", "for st marys ... B,S,G thats all, no need
   of W for walkins" - a plan-less St Mary's registration now gets a
   provisional BRONZE code (not a separate walk-in series); staff assign the
   real plan right after, and syncBagToPlan swaps it to the matching tier. */
import "dotenv/config";
import fs from "node:fs";
import pathMod from "node:path";
const adminSrc = () => fs.readFileSync(pathMod.resolve(__dirname, "..", "lib/actions/admin.ts"), "utf8");
const subsSrc = () => fs.readFileSync(pathMod.resolve(__dirname, "..", "lib/actions/subscription.ts"), "utf8");
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
  it("registerStudent returns a real bagCode (provisional Bronze), not the raw internal id", async () => {
    await db.staff.create({ data: { id: "stf1", phone: "9000000090", name: "Counter", role: 1, collegeId: "sm" } });
    await signInAsStaff();
    const r = await adminActions.registerStudent({ name: "New Walk-in", phone: "9822200001", collegeId: "sm", kind: "student" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bagCode).not.toBeNull();
    expect(r.bagCode).toMatch(/^B\d+$/);
    expect(r.bagCode).not.toBe(r.id);
    const bag = await db.bag.findFirst({ where: { studentId: r.id, status: "active" } });
    expect(bag?.code).toBe(r.bagCode);
  });

  it("customerIdFor self-heals the same way for a student who somehow still has no bag (never a raw id)", async () => {
    const stu = await db.student.create({ data: { id: "hea001", phone: "9822200002", name: "Healed Kid", collegeId: "sm", kind: "student" } });
    const code = await bagcode.customerIdFor(db, stu, "St Mary's");
    expect(code).toMatch(/^B\d+$/);
    expect(code).not.toBe(stu.id);
  });
});

describe("assigning a real plan swaps the provisional code for the matching tier (owner, Sep 22: \"it can be gold or silver also\")", { timeout: 90_000 }, () => {
  it("Bronze -> Gold: assignSubscription upgrades the bag code and it's visible in the database", async () => {
    await db.appConfig.upsert({
      where: { id: "main" },
      create: { id: "main", gstPct: 18, plan: {}, rates: { washFold: { label: "Wash & Fold", items: [] } }, payment: {}, settings: {} },
      update: {},
    });
    const plan = await db.plan.create({
      data: { collegeId: "sm", name: "Gold", tier: "gold", price: 6500, buckets: [{ service: "washFold", cycles: 34, kgPerCycle: 7 }] },
    });
    const r = await adminActions.registerStudent({ name: "Upgrade Test", phone: "9822200003", collegeId: "sm", kind: "student" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bagCode).toMatch(/^B\d+$/); // provisional, before any plan

    const subscription = await import("../lib/actions/subscription");
    // assignSubscription is Manager+ (role 2); registration itself is role 1.
    await db.staff.create({ data: { id: "mgr1", phone: "9000000091", name: "Manager", role: 2, collegeId: "sm" } });
    await authLib.createSession({ mode: "staff", staffId: "mgr1", role: 2, epoch: 0 });
    const assigned = await subscription.assignSubscription(r.id, plan.id, "cash", false);
    await signInAsStaff(); // back to the counter session for anything after
    expect(assigned.ok).toBe(true);

    // Reflected in the database: the OLD Bronze bag is retired, a new Gold one is active.
    const bags = await db.bag.findMany({ where: { studentId: r.id }, orderBy: { issuedAt: "asc" } });
    expect(bags.map((b) => b.code.charAt(0))).toEqual(["B", "G"]);
    expect(bags.find((b) => b.status === "active")?.code).toMatch(/^G\d+$/);
    expect(bags.find((b) => b.code === r.bagCode)?.status).toBe("replaced");

    const code = await bagcode.customerIdFor(db, { id: r.id, collegeId: "sm", kind: "student" }, "St Mary's");
    expect(code).toBe(bags.find((b) => b.status === "active")?.code);
  });

  it("registerStudent calls rosterSoon so the Sheet's roster tabs pick up the new student", () => {
    const src = adminSrc();
    const fn = src.slice(src.indexOf("export async function registerStudent"));
    expect(fn.slice(0, fn.indexOf("\nexport async function "))).toMatch(/rosterSoon\(\)/);
  });
  it("assignSubscription/activateSubscription/upgradeSubscription call rosterSoon so a plan assignment reaches the Sheet", () => {
    const src = subsSrc();
    for (const fn of ["assignSubscription", "activateSubscription", "upgradeSubscription"]) {
      const i = src.indexOf(`export async function ${fn}`);
      const body = src.slice(i, src.indexOf("\nexport async function ", i + 10));
      expect(body, fn).toMatch(/rosterSoon\(\)/);
    }
  });
});
