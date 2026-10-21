/* app/api/cron/collection-reminders/route.ts sends a "please collect your
   bag" push and only AFTERWARDS increments Order.collectionRemindersSent —
   the field whose own comment says it exists specifically so the daily cron
   can't re-send the same nudge every run. Reading the order, deciding to
   send, and incrementing are three separate steps with no lock between them.

   If a cron run is slow (Render default timeout, cold start, a push
   provider hanging) and a second run fires before the first finishes — a
   genuine overlap this schedule allows, and exactly the scenario the retry
   callout on the Render cron (same pattern as weekly-digest/daily-report's
   own "guards a retried trigger" comments) is meant to prevent elsewhere —
   both runs can read the SAME order with collectionRemindersSent still at
   its old value, both decide the 24h nudge is due, and both send the push
   before either one's increment lands. The final counter value is still
   correct (incremented twice), so nothing downstream notices, but the
   student receives the same "please collect it" notification twice for one
   event.

   Exercised for real against a live Postgres test schema: calls the route's
   exported GET handler twice concurrently against an order whose single
   ready-event is 25 hours old, and asserts pushNotif fired at most once. */
import "dotenv/config";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

// A deliberate delay inside pushNotif, same shape a real push-provider round
// trip has — long enough that BOTH concurrent runs' db.order.findMany reads
// land (and decide to send) before either one's increment is written. This
// is what a slow run + an overlapping retry actually look like: the race
// isn't about microtask ordering, it's that the increment only happens
// after the (slow) send.
const pushNotifCalls: unknown[][] = [];
vi.mock("../lib/notify", () => ({
  pushNotif: (...args: unknown[]) => {
    pushNotifCalls.push(args);
    return new Promise((resolve) => setTimeout(resolve, 75));
  },
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-collection-reminders-race.db");
const SCHEMA = "ff_collection_reminders_race";
const TEST_URL = IS_PG ? BASE.split("?")[0] + `?schema=${SCHEMA}` : "file:" + TEST_DB;
process.env.DATABASE_URL = TEST_URL;
process.env.CRON_SECRET = process.env.CRON_SECRET || "test-cron-secret-for-collection-reminders-race";

let db: typeof import("../lib/db").db;
let GET: typeof import("../app/api/cron/collection-reminders/route").GET;

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
  ({ GET } = await import("../app/api/cron/collection-reminders/route"));

  await db.college.create({ data: { id: "col1", name: "Test College", features: {} } });
  await db.student.create({ data: { id: "333333", phone: "9999900003", name: "Waiting Student", collegeId: "col1" } });

  const readyAt = new Date(Date.now() - 25 * 3_600_000); // 25h ago — past the 24h nudge threshold
  await db.order.create({
    data: {
      id: "race-order-1", studentId: "333333", collegeId: "col1", service: "washIron",
      items: [{ label: "Garment", rate: 10, qty: 10 }],
      declaredPieces: 10, subtotal: 100, gst: 0, gstPctSnapshot: 0, total: 100,
      status: "ready", collectionRemindersSent: 0,
      timeline: { create: [{ status: "ready", at: readyAt }] },
    },
  });
}, 300_000);

function cronRequest() {
  return new Request("https://x.test/api/cron/collection-reminders", {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
}

describe("collection-reminders cron is safe against an overlapping concurrent run", () => {
  it("does not send the same 24h nudge twice when two runs race on the same order", async () => {
    const [r1, r2] = await Promise.all([GET(cronRequest()), GET(cronRequest())]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    expect(pushNotifCalls.length).toBe(1);

    const order = await db.order.findUniqueOrThrow({ where: { id: "race-order-1" } });
    expect(order.collectionRemindersSent).toBe(1);
  });
});
