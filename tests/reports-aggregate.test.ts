/* The reports analytics, computed in the database instead of in JavaScript.

   The page used to read one row per ORDER EVER RECORDED to produce a repeat
   rate and a revenue total — on a screen that re-renders on a timer. The
   replacement groups in the database.

   The whole point of this file is EQUIVALENCE: the new query must return the
   same numbers as the old loop, on the same rows. A faster wrong answer is
   worse than a slow right one, and a repeat-rate percentage is exactly the
   kind of figure nobody would notice had drifted.
   Runs in the isolated ff_agg schema — never real data. */
import "dotenv/config";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureTestSchema } from "./_schema";
import path from "node:path";

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_URL = IS_PG ? BASE.split("?")[0] + "?schema=ff_agg" : "file:" + path.resolve(__dirname, "../test-agg.db");
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
const N = (x: unknown) => Number(x || 0);

/** Exactly what the page did before: every order, counted in JavaScript. */
async function oldWay() {
  const allOrders = await db.order.findMany({ select: { studentId: true, usedCycle: true, total: true, paid: true } });
  const byStudent = new Map<string, number>();
  allOrders.forEach((o) => byStudent.set(o.studentId, (byStudent.get(o.studentId) || 0) + 1));
  const repeatRate = byStudent.size
    ? Math.round((Array.from(byStudent.values()).filter((n) => n >= 2).length / byStudent.size) * 100)
    : 0;
  const payRevenue = allOrders.filter((o) => !o.usedCycle && o.paid).reduce((s, o) => s + N(o.total), 0);
  return { repeatRate, payRevenue, rowsRead: allOrders.length };
}

/** Exactly what the page does now. */
async function newWay() {
  const [perStudent, payAgg] = await Promise.all([
    db.order.groupBy({ by: ["studentId"], _count: { _all: true } }),
    db.order.aggregate({ _sum: { total: true }, where: { usedCycle: false, paid: true } }),
  ]);
  const repeatRate = perStudent.length
    ? Math.round((perStudent.filter((g) => g._count._all >= 2).length / perStudent.length) * 100)
    : 0;
  return { repeatRate, payRevenue: N(payAgg._sum.total), rowsRead: perStudent.length };
}

let ORDERS = 0;

beforeAll(async () => {
  db = (await import("../lib/db")).db;
  await ensureTestSchema(TEST_URL, async () => {
    try { await db.sheetOutbox.count(); return true; } catch { return false; }
  });

  for (const t of ["orderEvent", "order", "student", "college"] as const) {
    await (db as never as Record<string, { deleteMany: (a: unknown) => Promise<unknown> }>)[t].deleteMany({});
  }
  await db.college.create({ data: { id: "agg1", name: "Aggregate College", features: {} } });

  /* A deliberately awkward spread: one student with a single order, several
     with two or more, and one with none at all — because "students with no
     orders" is the case a GROUP BY silently drops, and the old loop dropped
     it too. Both must agree on that, not just on the easy shape. */
  const plan: Array<[string, number]> = [["s1", 1], ["s2", 2], ["s3", 5], ["s4", 1], ["s5", 3]];
  let n = 0;
  for (const [sid, count] of plan) {
    await db.student.create({ data: { id: sid, phone: "90000000" + sid.slice(1).padStart(2, "0"), name: "Agg " + sid, collegeId: "agg1" } });
    for (let i = 0; i < count; i++) {
      n++;
      await db.order.create({ data: {
        id: "AGG" + String(n).padStart(4, "0"), studentId: sid, collegeId: "agg1", service: "washIron",
        items: [{ label: "Regular garment", rate: 15, qty: 2 }], declaredPieces: 2,
        subtotal: 30, gst: 0, gstPctSnapshot: 18, total: 30 + i,
        // a mix of cycle / paid / unpaid, so the revenue filter is exercised
        usedCycle: i % 3 === 0, paid: i % 2 === 0, status: "collected",
      } });
    }
  }
  // a student who has never ordered — must not shift the repeat rate
  await db.student.create({ data: { id: "s6", phone: "9000000066", name: "Agg s6", collegeId: "agg1" } });
  ORDERS = n;
  // first run in a fresh schema has to `prisma db push`, which is not quick
}, 300_000);

describe("the new aggregate matches the old loop", () => {
  it("agrees on the repeat rate", async () => {
    const [a, b] = [await oldWay(), await newWay()];
    expect(b.repeatRate).toBe(a.repeatRate);
  });
  it("agrees on pay-per-use revenue", async () => {
    const [a, b] = [await oldWay(), await newWay()];
    expect(b.payRevenue).toBe(a.payRevenue);
  });
  it("agrees after more orders land", async () => {
    // equivalence has to survive the data changing, not just one fixture
    await db.order.create({ data: {
      id: "AGGX001", studentId: "s1", collegeId: "agg1", service: "washIron",
      items: [{ label: "Regular garment", rate: 15, qty: 1 }], declaredPieces: 1,
      subtotal: 15, gst: 0, gstPctSnapshot: 18, total: 99, usedCycle: false, paid: true, status: "collected",
    } });
    const [a, b] = [await oldWay(), await newWay()];
    expect(b).toMatchObject({ repeatRate: a.repeatRate, payRevenue: a.payRevenue });
  });
});

describe("it reads far fewer rows to get there", () => {
  it("returns one row per student, not one per order", async () => {
    const [a, b] = [await oldWay(), await newWay()];
    expect(a.rowsRead).toBe(ORDERS + 1);   // every order ever
    expect(b.rowsRead).toBe(5);            // the five students who have ordered
    expect(b.rowsRead).toBeLessThan(a.rowsRead);
  });
  it("the gap widens as orders accumulate — which is the whole point", async () => {
    const before = (await newWay()).rowsRead;
    for (let i = 0; i < 6; i++) {
      await db.order.create({ data: {
        id: "AGGY" + String(i).padStart(3, "0"), studentId: "s3", collegeId: "agg1", service: "washIron",
        items: [{ label: "Regular garment", rate: 15, qty: 1 }], declaredPieces: 1,
        subtotal: 15, gst: 0, gstPctSnapshot: 18, total: 15, usedCycle: false, paid: false, status: "collected",
      } });
    }
    // six more orders, same five students → the new query reads no more rows
    expect((await newWay()).rowsRead).toBe(before);
    expect((await oldWay()).rowsRead).toBe(ORDERS + 1 + 6);
  });
  it("still agrees on the numbers afterwards", async () => {
    const [a, b] = [await oldWay(), await newWay()];
    expect(b.repeatRate).toBe(a.repeatRate);
    expect(b.payRevenue).toBe(a.payRevenue);
  });
});

describe("empty database", () => {
  it("both give 0%, not a divide-by-zero", async () => {
    for (const t of ["orderEvent", "order"] as const) {
      await (db as never as Record<string, { deleteMany: (a: unknown) => Promise<unknown> }>)[t].deleteMany({});
    }
    const [a, b] = [await oldWay(), await newWay()];
    expect(a.repeatRate).toBe(0);
    expect(b.repeatRate).toBe(0);
    expect(b.payRevenue).toBe(0);
  });
});
