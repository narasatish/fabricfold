/* Registering a St Mary's student and its customer ID.

   History: found live (owner, Sep 21) — registering a new St Mary's student
   showed a random 6-digit id like "465456" instead of a real customer-facing
   code, because registerStudent only minted a bag for BVRIT and faculty
   students. A first fix (Sep 22) gave a plan-less walk-in a PROVISIONAL
   Bronze code, corrected once a plan was assigned later. The owner then
   corrected the design further, same day: "staff need to give plan as
   mandatory then obviously code with B/S/G will be assigned... no need [of]
   a provisional code" — so a St Mary's (non-faculty) registration now
   REQUIRES a plan up front, and the real tier letter is assigned immediately,
   never a placeholder. BVRIT is always V ("for bvrit... only V"); faculty are
   always F at either college — neither ever needs a plan. */
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

let smBronze: string, smSilver: string, smGold: string, bvritId: string;

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

  const sm = await db.college.create({ data: { id: "sm", name: "St Mary's", features: {} } });
  bvritId = (await db.college.create({ data: { id: "bv", name: "BVRIT", features: {}, rates: { washFold: { label: "Wash & Fold", items: [["Regular garment", 15]] } } } })).id;
  await db.appConfig.upsert({
    where: { id: "main" },
    create: { id: "main", gstPct: 18, plan: {}, rates: { washFold: { label: "Wash & Fold", items: [] } }, payment: {}, settings: {} },
    update: {},
  });
  const buckets = [{ service: "washFold", cycles: 20, kgPerCycle: 7 }];
  smBronze = (await db.plan.create({ data: { collegeId: sm.id, name: "Bronze", tier: "bronze", price: 4000, buckets } })).id;
  smSilver = (await db.plan.create({ data: { collegeId: sm.id, name: "Silver", tier: "silver", price: 5000, buckets } })).id;
  smGold = (await db.plan.create({ data: { collegeId: sm.id, name: "Gold", tier: "gold", price: 6500, buckets } })).id;

  await db.staff.create({ data: { id: "stf1", phone: "9000000090", name: "Counter", role: 1, collegeId: "sm" } });
  await db.staff.create({ data: { id: "mgr1", phone: "9000000091", name: "Manager", role: 2, collegeId: "sm" } });
}, 300_000);

const asCounter = () => authLib.createSession({ mode: "staff", staffId: "stf1", role: 1, epoch: 0 });
const asManager = () => authLib.createSession({ mode: "staff", staffId: "mgr1", role: 2, epoch: 0 });

let phoneSeq = 9822210000;
const nextPhone = () => String(phoneSeq++);

describe("St Mary's registration requires a plan up front (owner, Sep 22)", { timeout: 90_000 }, () => {
  it("refuses with no planId at all, and creates no student row", async () => {
    await asManager();
    const before = await db.student.count();
    const r = await adminActions.registerStudent({ name: "No Plan", phone: nextPhone(), collegeId: "sm", kind: "student" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/pick a plan/i);
    expect(await db.student.count()).toBe(before);
  });

  it("refuses with a planId but no payment method", async () => {
    await asManager();
    const before = await db.student.count();
    const r = await adminActions.registerStudent({ name: "No Method", phone: nextPhone(), collegeId: "sm", kind: "student", planId: smBronze });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/cash or upi/i);
    expect(await db.student.count()).toBe(before);
  });

  it("a Counter-level staff member (role 1) cannot register WITH a plan — selling a plan needs a Manager", async () => {
    await asCounter();
    const before = await db.student.count();
    const r = await adminActions.registerStudent({ name: "Counter Try", phone: nextPhone(), collegeId: "sm", kind: "student", planId: smBronze, method: "cash" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/manager/i);
    expect(await db.student.count()).toBe(before);
  });

  it("Manager + Bronze plan: registers, sells the plan, and issues a REAL Bronze code immediately — no provisional step", async () => {
    await asManager();
    const phone = nextPhone();
    const r = await adminActions.registerStudent({ name: "Bronze Buyer", phone, collegeId: "sm", kind: "student", planId: smBronze, method: "cash" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bagCode).toMatch(/^B\d+$/);
    expect(r.planError).toBeUndefined();

    const sub = await db.subscription.findUniqueOrThrow({ where: { studentId: r.id } });
    expect(sub.active).toBe(true);
    expect(sub.plan).toBe("Bronze");
    const bags = await db.bag.findMany({ where: { studentId: r.id } });
    expect(bags).toHaveLength(1); // exactly one bag, not a provisional-then-replaced pair
    expect(bags[0].code).toBe(r.bagCode);
    const payment = await db.payment.findFirstOrThrow({ where: { studentId: r.id } });
    expect(payment.method).toBe("cash");
    expect(Number(payment.amount)).toBeGreaterThan(0);
  });

  it("it can be Silver or Gold too — the code matches whichever plan is actually chosen (owner: \"it can be gold or silver also\")", async () => {
    await asManager();
    const silver = await adminActions.registerStudent({ name: "Silver Buyer", phone: nextPhone(), collegeId: "sm", kind: "student", planId: smSilver, method: "upi" });
    expect(silver.ok && silver.bagCode).toMatch(/^S\d+$/);
    const gold = await adminActions.registerStudent({ name: "Gold Buyer", phone: nextPhone(), collegeId: "sm", kind: "student", planId: smGold, method: "upi" });
    expect(gold.ok && gold.bagCode).toMatch(/^G\d+$/);
  });

  it("an invalid planId degrades gracefully: the student still exists with a safety-net code, not orphaned or crashed", async () => {
    await asManager();
    const r = await adminActions.registerStudent({ name: "Bad Plan Id", phone: nextPhone(), collegeId: "sm", kind: "student", planId: "does-not-exist", method: "cash" });
    expect(r.ok).toBe(true); // registration itself still succeeds
    if (!r.ok) return;
    expect(r.planError).toMatch(/could not be sold/i);
    expect(r.bagCode).not.toBeNull();
    expect(r.bagCode).not.toBe(r.id); // never the raw internal id, even on this failure path
    const stu = await db.student.findUniqueOrThrow({ where: { id: r.id } });
    expect(stu.name).toBe("Bad Plan Id");
    const sub = await db.subscription.findUnique({ where: { studentId: r.id } });
    expect(sub?.active).not.toBe(true); // no plan was actually sold
  });
});

describe("BVRIT and faculty are unaffected — never need a plan", () => {
  it("BVRIT registration (Counter-level, no plan) still gets V immediately", async () => {
    await asCounter();
    const r = await adminActions.registerStudent({ name: "BVRIT Kid", phone: nextPhone(), collegeId: bvritId, kind: "student" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bagCode).toMatch(/^V\d+$/);
  });

  it("faculty at St Mary's (Counter-level, no plan) still gets F immediately", async () => {
    await asCounter();
    const r = await adminActions.registerStudent({ name: "SM Faculty", phone: nextPhone(), collegeId: "sm", kind: "faculty" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bagCode).toMatch(/^F\d+$/);
  });

  it("faculty at BVRIT (Counter-level, no plan) still gets F immediately", async () => {
    await asCounter();
    const r = await adminActions.registerStudent({ name: "BVRIT Faculty", phone: nextPhone(), collegeId: bvritId, kind: "faculty" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bagCode).toMatch(/^F\d+$/);
  });
});

describe("customerIdFor's safety-net self-heal (a student that somehow still has no bag at all)", () => {
  it("defaults to Bronze, never the raw internal id", async () => {
    const stu = await db.student.create({ data: { id: "hea001", phone: nextPhone(), name: "Healed Kid", collegeId: "sm", kind: "student" } });
    const code = await bagcode.customerIdFor(db, stu, "St Mary's");
    expect(code).toMatch(/^B\d+$/);
    expect(code).not.toBe(stu.id);
  });
});

describe("everything reaches the Sheet's roster (rosterSoon)", () => {
  it("registerStudent calls rosterSoon so a new student appears", () => {
    const src = adminSrc();
    const fn = src.slice(src.indexOf("export async function registerStudent"));
    expect(fn.slice(0, fn.indexOf("\nexport async function "))).toMatch(/rosterSoon\(\)/);
  });
  it("assignSubscription/activateSubscription/upgradeSubscription call rosterSoon so a later plan change appears", () => {
    const src = subsSrc();
    for (const fn of ["assignSubscription", "activateSubscription", "upgradeSubscription"]) {
      const i = src.indexOf(`export async function ${fn}`);
      const body = src.slice(i, src.indexOf("\nexport async function ", i + 10));
      expect(body, fn).toMatch(/rosterSoon\(\)/);
    }
  });
});
