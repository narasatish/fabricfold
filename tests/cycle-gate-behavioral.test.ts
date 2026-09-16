/* Behavioral test (real function calls against a real test DB, not a
   source-regex check) for the cycle/subscription gate added 2026-09-05:
   a college with its own item-rates override (e.g. BVRIT) bills strictly
   per piece, so staff must not be able to sell it a cycle pack or assign a
   plan — that per-order rule (money.ts's collegeUsesCycleBasedPricing) had
   never been enforced on the bulk cycle-selling actions until now. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.98" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-cycle-gate.db");
const SCHEMA = "ff_cycle_gate";
const TEST_URL = IS_PG ? BASE.split("?")[0] + `?schema=${SCHEMA}` : "file:" + TEST_DB;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let sub: typeof import("../lib/actions/subscription");

beforeAll(async () => {
  if (IS_PG) {
    const { Client } = await import("pg");
    const admin = new Client({ connectionString: BASE.split("?")[0] });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
    await admin.end();
    execSync("npx prisma db push", {
      cwd: path.resolve(__dirname, ".."), stdio: "ignore",
      env: { ...process.env, DATABASE_URL: TEST_URL },
    });
  } else {
    if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB);
    execSync(`npx prisma db push --url "file:${TEST_DB}"`, { cwd: path.resolve(__dirname, ".."), stdio: "ignore" });
  }
  db = (await import("../lib/db")).db;
  auth = await import("../lib/auth");
  sub = await import("../lib/actions/subscription");

  // Per-piece college: BVRIT-like, has its own item rates override.
  await db.college.create({
    data: { id: "perpiece", name: "Per-Piece Campus", features: {}, rates: { washFold: { label: "Wash & Fold", items: [["Garment", 20]] } } },
  });
  // Cycle-based college: no rates override, uses global cycle pricing.
  await db.college.create({ data: { id: "cyclebased", name: "Cycle Campus", features: {}, rates: undefined } });

  await db.student.create({ data: { id: "222222", phone: "9999900002", name: "PerPiece Student", collegeId: "perpiece", credits: 0 } });
  await db.student.create({ data: { id: "333333", phone: "9999900003", name: "CycleBased Student", collegeId: "cyclebased", credits: 0 } });

  await db.staff.create({ data: { id: "staffpp", phone: "9000000098", name: "PP Manager", role: 2, collegeId: "perpiece" } });
  await db.staff.create({ data: { id: "staffcb", phone: "9000000097", name: "CB Manager", role: 2, collegeId: "cyclebased" } });

  // A college literally named BVRIT, but with DEFAULTS everywhere else
  // (rates: null, features.subscriptions left unset/true) — the exact
  // "live database misconfigured" scenario the name-based backstop exists
  // for, since this session cannot directly confirm BVRIT's real production
  // rates/features values.
  await db.college.create({ data: { id: "bvrit", name: "BVRIT", features: {} } });
  await db.student.create({ data: { id: "777777", phone: "9999900007", name: "BVRIT Student", collegeId: "bvrit", credits: 0 } });
  await db.staff.create({ data: { id: "staffbvrit", phone: "9000000094", name: "BVRIT Manager", role: 2, collegeId: "bvrit" } });
}, 300_000);

async function loginAs(staffId: string) {
  const staff = await db.staff.findUniqueOrThrow({ where: { id: staffId } });
  cookieJar.clear();
  await auth.createSession({ mode: "staff", staffId: staff.id, role: staff.role, epoch: staff.sessionEpoch });
}

describe("bulk cycle-selling actions respect a college's per-piece rates override", () => {
  it("sellCyclePack is refused for a per-piece (rates-override) college", async () => {
    await loginAs("staffpp");
    const r = await sub.sellCyclePack("222222", { service: "washFold", cycles: 10, method: "cash" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/bills per piece/);
  });

  it("sellCyclePack succeeds for a cycle-based (no override) college", async () => {
    await loginAs("staffcb");
    const r = await sub.sellCyclePack("333333", { service: "washFold", cycles: 10, method: "cash" });
    expect(r.ok).toBe(true);
  });

  it("assignSubscription is refused for a per-piece (rates-override) college", async () => {
    await loginAs("staffpp");
    const plan = await db.plan.create({
      data: { collegeId: "perpiece", name: "Bronze", price: 5000, buckets: [{ service: "washFold", cycles: 20, kgPerCycle: 7 }] },
    });
    const r = await sub.assignSubscription("222222", plan.id, "cash");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/bills per piece/);
  });

  it("BVRIT is refused by name alone, even with rates: null and features.subscriptions unset (default true) — the owner's rule holds even if BVRIT's live rates/features are ever misconfigured", async () => {
    await loginAs("staffbvrit");
    const packResult = await sub.sellCyclePack("777777", { service: "washFold", cycles: 10, method: "cash" });
    expect(packResult.ok).toBe(false);
    if (!packResult.ok) expect(packResult.error).toMatch(/BVRIT bills per piece/);

    const plan = await db.plan.create({
      data: { collegeId: "bvrit", name: "Bronze", price: 5000, buckets: [{ service: "washFold", cycles: 20, kgPerCycle: 7 }] },
    });
    const assignResult = await sub.assignSubscription("777777", plan.id, "cash");
    expect(assignResult.ok).toBe(false);
    if (!assignResult.ok) expect(assignResult.error).toMatch(/BVRIT bills per piece/);
  });
});

describe("sellCyclePack does not corrupt a subscription that predates the bucket model", () => {
  /* Found live 2026-09-16: a subscription tracked the OLD way — flat
     cyclesTotal/cyclesUsed, buckets empty — is a real, reachable state
     (walkInOrder's own consumption check has a fallback branch for exactly
     this). sellCyclePack used to compute cyclesTotal as ONLY the sum of the
     fresh bucket array it was about to write, discarding the real
     cyclesTotal — a student with a real 34-cycle plan (20 used) who bought
     a 2-cycle top-up ended up with cyclesTotal=2 while cyclesUsed stayed at
     20, an invalid state. The plan's real NAME was overwritten to "Cycle
     pack — X" too, as if the named plan had been replaced by a walk-up
     pack. */
  it("preserves cyclesTotal, cyclesUsed, and the plan name for a bucket-less (legacy) subscription", async () => {
    await db.student.create({ data: { id: "444444", phone: "9999900004", name: "Legacy Plan Student", collegeId: "cyclebased", credits: 0 } });
    await db.subscription.create({
      data: { studentId: "444444", active: true, plan: "Annual Plan", cyclesTotal: 34, cyclesUsed: 20, buckets: [], kgPerCycle: 7 },
    });

    await loginAs("staffcb");
    const r = await sub.sellCyclePack("444444", { service: "washFold", cycles: 2, method: "cash" });
    expect(r.ok).toBe(true);

    const after = await db.subscription.findUniqueOrThrow({ where: { studentId: "444444" } });
    expect(after.plan).toBe("Annual Plan"); // NOT renamed to "Cycle pack — Wash & Fold"
    expect(after.cyclesTotal).toBe(36); // 34 + 2, NOT reset to 2
    expect(after.cyclesUsed).toBe(20); // untouched — cyclesUsed must never exceed cyclesTotal
    expect((after.buckets as unknown[]).length).toBe(0); // stays in flat-counter mode, not force-migrated
  });

  it("a subscription that already uses buckets still adds to them normally (unaffected by the legacy-mode fix)", async () => {
    await db.student.create({ data: { id: "555555", phone: "9999900005", name: "Bucketed Student", collegeId: "cyclebased", credits: 0 } });
    await db.subscription.create({
      data: {
        studentId: "555555", active: true, plan: "Silver",
        buckets: [{ service: "washFold", cycles: 10, used: 3, kgPerCycle: 7 }],
        cyclesTotal: 10, cyclesUsed: 3, kgPerCycle: 7,
      },
    });

    await loginAs("staffcb");
    const r = await sub.sellCyclePack("555555", { service: "washFold", cycles: 5, method: "cash" });
    expect(r.ok).toBe(true);

    const after = await db.subscription.findUniqueOrThrow({ where: { studentId: "555555" } });
    expect(after.plan).toBe("Silver"); // named plan preserved here too
    const buckets = after.buckets as { service: string; cycles: number; used: number }[];
    expect(buckets.find((b) => b.service === "washFold")?.cycles).toBe(15); // 10 + 5
    expect(buckets.find((b) => b.service === "washFold")?.used).toBe(3); // usage untouched
    expect(after.cyclesTotal).toBe(15);
  });
});
