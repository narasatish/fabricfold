/* Money-path tests: GST split, per-FY invoice numbering (no gaps), refund
   credit-note proportionality, credit-split payment, drawer reconciliation. */
import "dotenv/config";
import { beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

/* Run the money tests in an isolated schema so they never touch real data:
   - Postgres (Supabase): a throwaway schema on the same database.
   - SQLite fallback: a local test.db file (if DATABASE_URL is a file: URL).
   Prefer DIRECT_URL (session pooler) — these do DDL, which needs it.

   ff_money, NOT the shared ff_test — and this is the important part.

   This file starts by DROPPING its schema and rebuilding it, because these
   tests want a pristine ledger: invoice numbering must be gap-free from 1, so
   leftover rows would break it. That is fine on a schema it owns and
   catastrophic on a shared one. It used to drop ff_test, which four other
   files use, WHILE vitest ran them in parallel — their tables vanished
   mid-test. Every intermittent failure chased this session traces back here:
   "no code stored" in otp-security (the Otp table had just been dropped),
   "Command failed: npx prisma db push" in washday (colliding with the
   recreate), and the QA pipeline's bag-code assertion (the partial unique
   indexes went with the schema).

   Owning its own schema means it can keep the clean-slate guarantee its
   assertions depend on without reaching into anyone else's. */
const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test.db");
const MONEY_SCHEMA = "ff_money";
const TEST_URL = IS_PG ? BASE.split("?")[0] + `?schema=${MONEY_SCHEMA}` : "file:" + TEST_DB;
process.env.DATABASE_URL = TEST_URL;

// imported lazily after env is set
let db: typeof import("../lib/db").db;
let money: typeof import("../lib/money");
let report: typeof import("../lib/report");

beforeAll(async () => {
  if (IS_PG) {
    // wipe & recreate the isolated test schema, then build tables in it
    const { Client } = await import("pg");
    const admin = new Client({ connectionString: BASE.split("?")[0] });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${MONEY_SCHEMA} CASCADE; CREATE SCHEMA ${MONEY_SCHEMA};`);
    await admin.end();
    execSync("npx prisma db push", {
      cwd: path.resolve(__dirname, ".."), stdio: "ignore",
      env: { ...process.env, DATABASE_URL: TEST_URL },
    });
  } else {
    if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB);
    execSync(`npx prisma db push --url "file:${TEST_DB}"`, {
      cwd: path.resolve(__dirname, ".."), stdio: "ignore",
    });
  }
  db = (await import("../lib/db")).db;
  money = await import("../lib/money");
  report = await import("../lib/report");

  await db.college.create({ data: { id: "col1", name: "Test College", features: {} } });
  await db.student.create({ data: { id: "111111", phone: "9999900001", name: "Test Student", collegeId: "col1", credits: 100 } });
  await db.appConfig.create({
    data: {
      id: "main", gstPct: 18,
      plan: { price: 6800, cycles: 34, kgPerCycle: 7 },
      rates: { washIron: { label: "Wash & Iron", items: [["Regular garment", 15]] } },
      payment: {}, settings: { openingFloat: 500 },
    },
  });
  // `prisma db push` against a remote Postgres is the slow part, and it grows
  // with the schema — 120s was already marginal and broke once the Bag table
  // landed. Kept generous on purpose: this hook is setup, not a perf budget.
}, 300_000);

function mkOrder(id: string, total: number, gst: number) {
  return db.order.create({
    data: {
      id, studentId: "111111", collegeId: "col1", service: "washIron",
      items: [{ label: "Regular garment", rate: 15, qty: 10 }],
      subtotal: total - gst, gst, gstPctSnapshot: 18, total,
    },
  });
}

describe("financial year tag (Indian FY, April start)", () => {
  it("March belongs to the previous FY, April starts the new one", () => {
    expect(money.financialYearTag(new Date("2026-03-31"))).toBe("2526");
    expect(money.financialYearTag(new Date("2026-04-01"))).toBe("2627");
  });
});

describe("GST is payment-method driven", () => {
  it("UPI invoices, cash does not (unless override), credit never", () => {
    expect(money.shouldInvoice("upi")).toBe(true);
    expect(money.shouldInvoice("upi+credit")).toBe(true);
    expect(money.shouldInvoice("cash")).toBe(false);
    expect(money.shouldInvoice("cash", true)).toBe(true);
    expect(money.shouldInvoice("cash+credit")).toBe(false);
    expect(money.shouldInvoice("cash+credit", true)).toBe(true);
    expect(money.shouldInvoice("credit")).toBe(false);
    expect(money.shouldInvoice("credit", true)).toBe(false);
  });
});

describe("no-GST billing (staff choice at accept)", () => {
  it("computeBill: GST on → 18% added; GST off → gst 0, total = subtotal + surcharge", () => {
    expect(money.computeBill(150, 0, 18)).toEqual({ gst: 27, total: 177 });
    expect(money.computeBill(150, 0, 18, { noGst: true })).toEqual({ gst: 0, total: 150 });
    expect(money.computeBill(150, 100, 18, { noGst: true })).toEqual({ gst: 0, total: 250 });
    // cycle orders ignore noGst — they only carry the excess charge
    expect(money.computeBill(150, 0, 18, { usedCycle: true, excessCharge: 45, noGst: true })).toEqual({ gst: 0, total: 45 });
    // cycle order marked urgent still collects the cash surcharge (bug fix — was silently dropped)
    expect(money.computeBill(150, 59, 18, { usedCycle: true, excessCharge: 0 })).toEqual({ gst: 0, total: 59 });
  });

  it("expressFlatFee: a flat same-day fee per service, no percentage anywhere (owner, Sep 2026 — second pass)", () => {
    // owner's own numbers: 99 Wash & Iron; 79 Wash & Fold and Dry Cleaning
    expect(money.expressFlatFee("washIron")).toBe(99);
    expect(money.expressFlatFee("washFold")).toBe(79);
    expect(money.expressFlatFee("dryClean")).toBe(79);
    // Iron Only has no owner-given rate — it inherits the base tier rather
    // than reviving a percentage the owner explicitly rejected
    expect(money.expressFlatFee("ironOnly")).toBe(79);
    // an unrecognised service still gets a real number, never zero or NaN
    expect(money.expressFlatFee("somethingElse")).toBe(79);
    // SAME fee whether the order is plan-paid or cash-paid — no plan-price
    // dependence left (the old urgentCycleCharge derived from planPrice/cycles)
    expect(money.computeBill(150, money.expressFlatFee("washFold"), 18, { usedCycle: true, excessCharge: 0 }))
      .toEqual({ gst: 0, total: 79 });
    expect(money.computeBill(200, money.expressFlatFee("washFold"), 18, { usedCycle: false, excessCharge: 0, noGst: true }))
      .toEqual({ gst: 0, total: 279 });
  });

  it("a no-GST order is never invoiced — not even via UPI or staff override", () => {
    expect(money.shouldInvoiceOrder({ noGst: true }, "upi")).toBe(false);
    expect(money.shouldInvoiceOrder({ noGst: true }, "upi+credit")).toBe(false);
    expect(money.shouldInvoiceOrder({ noGst: true }, "cash", true)).toBe(false);
    // normal orders keep the method-driven rule
    expect(money.shouldInvoiceOrder({ noGst: false }, "upi")).toBe(true);
    expect(money.shouldInvoiceOrder({ noGst: false }, "cash")).toBe(false);
    expect(money.shouldInvoiceOrder({ noGst: false }, "cash", true)).toBe(true);
  });

  it("no-GST payment is still recorded in the ledger but adds nothing to GST totals", async () => {
    const o = await db.order.create({
      data: {
        id: "FF00NOGST", studentId: "111111", collegeId: "col1", service: "washIron",
        items: [{ label: "Regular garment", rate: 15, qty: 10 }],
        subtotal: 150, gst: 0, gstPctSnapshot: 0, total: 150, noGst: true,
      },
    });
    const before = await report.computeReport(report.parsePeriod({ p: "all" }));
    await db.$transaction(async (tx) => {
      await tx.payment.create({ data: { method: "upi", amount: 150, orderId: o.id, collegeId: "col1", studentId: "111111" } });
      const updated = await tx.order.update({ where: { id: o.id }, data: { paid: true, paymentMethod: "upi" } });
      if (money.shouldInvoiceOrder(updated, "upi")) await money.createInvoice(tx, updated, "upi");
    });
    const after = await report.computeReport(report.parsePeriod({ p: "all" }));
    expect(after.upi - before.upi).toBe(150); // revenue recorded
    expect(after.gstCollected).toBe(before.gstCollected); // no GST impact
    expect(await db.invoice.findUnique({ where: { orderId: o.id } })).toBeNull(); // no invoice
  });
});

describe("invoice numbering — transactional per-FY sequence", () => {
  it("issues INV-<FY>-0001, 0002 ... with no gaps or duplicates", async () => {
    const o1 = await mkOrder("FF000001", 118, 18);
    const o2 = await mkOrder("FF000002", 236, 36);
    const fy = money.financialYearTag();
    const inv1 = await db.$transaction((tx) => money.createInvoice(tx, o1, "upi"));
    const inv2 = await db.$transaction((tx) => money.createInvoice(tx, o2, "upi"));
    expect(inv1.number).toBe(`INV-${fy}-0001`);
    expect(inv2.number).toBe(`INV-${fy}-0002`);
  });
});

describe("refund credit-note proportionality", () => {
  it("half refund raises a credit note with half the GST", async () => {
    const o = await mkOrder("FF000003", 200, 30); // total 200, gst 30
    const inv = await db.$transaction((tx) => money.createInvoice(tx, o, "upi"));
    const cn = await db.$transaction((tx) => money.createCreditNote(tx, inv, 100, "test", "stf", "upi"));
    expect(Number(cn.gst)).toBeCloseTo(15, 1); // 30 * (100/200)
    expect(Number(cn.subtotal)).toBeCloseTo(85, 1);
    expect(Number(cn.total)).toBe(100);
    const fy = money.financialYearTag();
    expect(cn.number).toBe(`CN-${fy}-0001`);
  });

  it("full refund credit note carries the full GST", async () => {
    const o = await mkOrder("FF000004", 118, 18);
    const inv = await db.$transaction((tx) => money.createInvoice(tx, o, "upi"));
    const cn = await db.$transaction((tx) => money.createCreditNote(tx, inv, 118, "full", "stf", "credit"));
    expect(Number(cn.gst)).toBeCloseTo(18, 1);
  });
});

describe("credit-split payment", () => {
  it("splits credits first, remainder by method; ledger rows sum to the bill", async () => {
    const o = await mkOrder("FF000005", 150, 23);
    // replicate payCore's writes (action itself needs a web session)
    await db.$transaction(async (tx) => {
      await tx.student.update({ where: { id: "111111" }, data: { credits: { decrement: 100 } } });
      await tx.creditUse.create({ data: { studentId: "111111", orderId: o.id, amount: 100 } });
      await tx.payment.create({ data: { method: "credit", amount: 100, orderId: o.id, collegeId: "col1", studentId: "111111" } });
      await tx.payment.create({ data: { method: "upi", amount: 50, orderId: o.id, collegeId: "col1", studentId: "111111" } });
      await tx.order.update({ where: { id: o.id }, data: { paid: true, creditApplied: 100, paymentMethod: "upi+credit" } });
    });
    const rows = await db.payment.findMany({ where: { orderId: o.id } });
    expect(rows.reduce((s, r) => s + Number(r.amount), 0)).toBe(150);
    const stu = await db.student.findUniqueOrThrow({ where: { id: "111111" } });
    expect(Number(stu.credits)).toBe(0);
    expect(money.shouldInvoice("upi+credit")).toBe(true); // split with UPI still invoices
  });
});

describe("cash-drawer reconciliation", () => {
  it("opening float + cash in − cash refunds − payouts − cash expenses = expected drawer", async () => {
    await db.payment.create({ data: { method: "cash", amount: 800, collegeId: "col1" } });
    await db.payment.create({ data: { method: "refund", refundVia: "cash", amount: -100, collegeId: "col1" } });
    await db.payment.create({ data: { method: "cash_out", amount: -50, collegeId: "col1" } });
    await db.expense.create({ data: { category: "Supplies", amount: 200, method: "cash", by: "stf", collegeId: "col1" } });
    const r = await report.computeReport(report.parsePeriod({ p: "day" }));
    // 500 float + 800 cash − 100 cash refund − 50 payout − 200 cash expense
    expect(r.expectedDrawer).toBe(950);
  });

  it("net GST payable = collected − credit-note GST", async () => {
    const r = await report.computeReport(report.parsePeriod({ p: "all" }));
    expect(r.netGst).toBeCloseTo(r.gstCollected - r.cnGst, 2);
    expect(r.gstCollected).toBeCloseTo(18 + 36 + 30 + 18, 1);
    expect(r.cnGst).toBeCloseTo(15 + 18, 1);
  });
});
