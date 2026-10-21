/* sendPushTo (lib/push.ts), exercised for REAL against a real test DB — not by
   reading source text. Found in the Oct 2026 complaint/notification audit:
   lib/notify.ts's sendWhatsApp/waPost already learned (2026-10-01, see that
   file's own comments) that a failed send reaching only console.error is
   invisible on Render's serverless logs — nobody reviews them, and the App
   Errors panel stays empty, so a sustained outage (expired VAPID key, a
   provider 500, a network error) looks identical to "nothing happened,
   working fine" from the owner's side. That fix (logWaFailure -> ErrorLog)
   was applied to WhatsApp only. Web Push (lib/push.ts's sendPushTo, the
   function pushNotif() in lib/notify.ts actually calls for every student
   notification) never got the same treatment: its catch block only deletes
   the subscription on 404/410 (correctly — the subscription really is dead)
   but for every OTHER failure (410 aside, think a 500 from the push
   service, a malformed payload, a network timeout) the error is swallowed
   completely — no console.error, no ErrorLog row, nothing. A push-delivery
   outage would produce zero visible symptoms anywhere in the app ever. This
   test proves a non-404/410 failure now lands in ErrorLog, the same place
   the WhatsApp failures already do, and that a real 410 still just deletes
   the stale subscription with no log noise (this is the expected, benign
   path — not a failure to be visible about). */
import "dotenv/config";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";

const sendNotification = vi.fn();
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_push_failure_visibility";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;
process.env.VAPID_PUBLIC_KEY = "test-pub";
process.env.VAPID_PRIVATE_KEY = "test-priv";

let db: typeof import("../lib/db").db;
let push: typeof import("../lib/push");

beforeAll(async () => {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: BASE.split("?")[0] });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await c.end();
  execSync("npx prisma db push", { cwd: path.resolve(__dirname, ".."), stdio: "ignore", env: { ...process.env, DATABASE_URL: TEST_URL } });

  db = (await import("../lib/db")).db;
  push = await import("../lib/push");

  await db.college.create({ data: { id: "col1", name: "Push Visibility College", features: {} } });
  await db.student.create({ data: { id: "stu1", phone: "9000000001", name: "Push Student A", collegeId: "col1" } });
  await db.student.create({ data: { id: "stu2", phone: "9000000002", name: "Push Student B", collegeId: "col1" } });
}, 300_000);

describe("sendPushTo makes delivery failures visible", () => {
  it("logs a non-404/410 failure to ErrorLog instead of swallowing it silently", async () => {
    sendNotification.mockReset();
    sendNotification.mockRejectedValue(Object.assign(new Error("Push service unavailable"), { statusCode: 500 }));
    await db.pushSubscription.create({
      data: { userKind: "student", userId: "stu1", endpoint: "https://fcm.googleapis.com/fcm/send/live-1", p256dh: "p", auth: "a" },
    });

    const before = await db.errorLog.count();
    await push.sendPushTo("student", "stu1", { title: "FabricFold", body: "Your order is ready" });
    const after = await db.errorLog.count();

    expect(after).toBeGreaterThan(before);
    const rows = await db.errorLog.findMany({ where: { kind: "client" }, orderBy: { at: "desc" }, take: 5 });
    expect(rows.some((r) => r.message.includes("Push") && r.message.includes("500"))).toBe(true);

    // the live subscription must NOT be deleted on a transient 500 — only on 404/410
    const stillThere = await db.pushSubscription.findFirst({ where: { endpoint: "https://fcm.googleapis.com/fcm/send/live-1" } });
    expect(stillThere).not.toBeNull();
  });

  it("still just deletes the subscription on a real 410, with no error-log noise", async () => {
    sendNotification.mockReset();
    sendNotification.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));
    await db.pushSubscription.create({
      data: { userKind: "student", userId: "stu2", endpoint: "https://fcm.googleapis.com/fcm/send/dead-1", p256dh: "p", auth: "a" },
    });

    const before = await db.errorLog.count();
    await push.sendPushTo("student", "stu2", { title: "FabricFold", body: "Your order is ready" });
    const after = await db.errorLog.count();

    expect(after).toBe(before);
    const gone = await db.pushSubscription.findFirst({ where: { endpoint: "https://fcm.googleapis.com/fcm/send/dead-1" } });
    expect(gone).toBeNull();
  });
});
