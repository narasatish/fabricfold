/* computeReport() (lib/report.ts) feeds the staff Reports screen's
   "Orders received" tile. It counted EVERY Order row created in the period
   — including a draft that was never accepted at the counter (an abandoned
   app booking nobody ever dropped clothes off for) and an order that was
   cancelled before any wash happened. Neither represents a real order the
   counter "received" — a draft never reached the counter at all, and a
   cancellation undoes receipt the same way `payments`/`invoices` already
   correctly exclude a cancelled order's money (refundOrder/cancelOrder both
   reverse their effect on the money-side figures above `ordersIn` in the
   same report). Counting them inflates the figure the owner watches to
   gauge how busy a campus actually is, and skews avgTurnaround's denominator
   context on the same card.

   Found in the admin/reports/registration audit, 2026-10-21.

   Runs against an isolated ff_test-style schema, never real data. */
import "dotenv/config";
import { beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_report_ordersin";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let report: typeof import("../lib/report");

beforeAll(async () => {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: BASE.split("?")[0] });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await c.end();
  execSync("npx prisma db push", { cwd: path.resolve(__dirname, ".."), stdio: "ignore", env: { ...process.env, DATABASE_URL: TEST_URL } });

  db = (await import("../lib/db")).db;
  report = await import("../lib/report");

  await db.appConfig.create({
    data: {
      id: "main", gstPct: 18,
      plan: { price: 6800, cycles: 34, kgPerCycle: 7 },
      rates: { wash: { label: "Wash & Fold", items: [["Shirt", 20]] } },
      payment: { upiId: "ff@test", payeeName: "Test", bankName: "", accountName: "", accountNo: "", ifsc: "", gatewayKey: "" },
      settings: { reportEmail: "", dailyEmail: false, sendHour: 21, lastSent: null, openingFloat: 0 },
    },
  });
  await db.college.create({ data: { id: "rep1", name: "Report Orders College", features: {} } });
  await db.student.create({ data: { id: "repstu1", phone: "9990001234", name: "Report Student", collegeId: "rep1" } });
}, 300_000);

describe("computeReport's ordersIn excludes draft and cancelled orders", () => {
  it("counts only orders actually received at the counter, not abandoned drafts or cancellations", async () => {
    const now = new Date();
    const from = new Date(now.getTime() - 3_600_000);
    const to = new Date(now.getTime() + 3_600_000);

    // One real, accepted order — this should count.
    await db.order.create({
      data: {
        id: "REP0001", studentId: "repstu1", collegeId: "rep1", service: "wash",
        items: [{ label: "Shirt", rate: 20, qty: 2 }], declaredPieces: 2,
        subtotal: 40, gst: 0, gstPctSnapshot: 0, total: 40,
        status: "received", createdAt: now,
      },
    });

    // An abandoned draft — never accepted, nothing was ever "received".
    await db.order.create({
      data: {
        id: "REP0002", studentId: "repstu1", collegeId: "rep1", service: "wash",
        items: [], declaredPieces: 0,
        subtotal: 0, gst: 0, gstPctSnapshot: 0, total: 0,
        status: "draft", createdAt: now,
      },
    });

    // A cancelled order — receipt was undone.
    await db.order.create({
      data: {
        id: "REP0003", studentId: "repstu1", collegeId: "rep1", service: "wash",
        items: [{ label: "Shirt", rate: 20, qty: 1 }], declaredPieces: 1,
        subtotal: 20, gst: 0, gstPctSnapshot: 0, total: 20,
        status: "cancelled", createdAt: now,
      },
    });

    const r = await report.computeReport({ kind: "day", from, to, label: "test" }, "rep1");
    expect(r.ordersIn).toBe(1);
  });
});
