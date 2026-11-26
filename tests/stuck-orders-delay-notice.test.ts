/* Behavioral test for app/api/cron/stuck-orders/route.ts's 2026-11 addition:
   besides the existing owner email, a student whose order has sat in
   received/processing past STUCK_HOURS now gets a one-time apology push
   (Order.delayNotifiedAt gates it so a second cron run never re-sends the
   same notice). Proves: a fresh order under the threshold is left alone,
   an order past it gets exactly one Notification with the apology text and
   delayNotifiedAt set, and running the cron again sends nothing more for
   that same order. */
import "dotenv/config";
import { beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_stuck_delay_notice";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;
process.env.CRON_SECRET = "test-cron-secret";

let db: typeof import("../lib/db").db;
let GET: (req: Request) => Promise<Response>;

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
  process.env.OWNER_EMAIL = "owner@test.fabricfold.in";

  await db.college.create({ data: { id: "col1", name: "Stuck College", features: {} } });
  await db.student.create({ data: { id: "stu1", phone: "9000000041", name: "Waiting Student", collegeId: "col1" } });
  await db.student.create({ data: { id: "stu2", phone: "9000000042", name: "Fresh-Order Student", collegeId: "col1" } });

  const mod = await import("../app/api/cron/stuck-orders/route");
  GET = mod.GET;
}, 300_000);

const mkOrder = (id: string, studentId: string, receivedAt: Date, status = "received") =>
  db.order.create({
    data: {
      id, studentId, collegeId: "col1", service: "washFold", items: [{ label: "Regular garment", rate: 15, qty: 2 }],
      declaredPieces: 2, status, subtotal: 100, gst: 0, gstPctSnapshot: 0, total: 100, receivedAt,
    },
  });

const req = () => GET(new Request("https://fabricfold.in/api/cron/stuck-orders", { headers: { authorization: "Bearer test-cron-secret" } }));

describe("stuck-orders cron — per-student delay apology", () => {
  it("leaves a fresh order (well under STUCK_HOURS) alone", async () => {
    await mkOrder("FRESH01", "stu2", new Date());
    await req();
    const o = await db.order.findUniqueOrThrow({ where: { id: "FRESH01" } });
    expect(o.delayNotifiedAt).toBeNull();
    const notifs = await db.notification.findMany({ where: { studentId: "stu2" } });
    expect(notifs.length).toBe(0);
  });

  it("notifies the student exactly once for an order stuck past the threshold", async () => {
    const old = new Date(Date.now() - 8 * 3_600_000); // 8h ago, STUCK_HOURS is 6
    await mkOrder("STUCK01", "stu1", old);

    const res1 = await req();
    const body1 = await res1.json();
    expect(body1.ok).toBe(true);
    expect(body1.studentsNotified).toBeGreaterThanOrEqual(1);

    const afterFirst = await db.order.findUniqueOrThrow({ where: { id: "STUCK01" } });
    expect(afterFirst.delayNotifiedAt).not.toBeNull();

    const notifs = await db.notification.findMany({ where: { studentId: "stu1" } });
    expect(notifs.length).toBe(1);
    expect(notifs[0].text).toMatch(/delay/i);
    expect(notifs[0].text).toMatch(/sorry/i);

    // Second run must not re-notify the same order.
    const res2 = await req();
    const body2 = await res2.json();
    expect(body2.studentsNotified).toBe(0);
    const notifsAfterSecondRun = await db.notification.findMany({ where: { studentId: "stu1" } });
    expect(notifsAfterSecondRun.length).toBe(1);
  });
});
