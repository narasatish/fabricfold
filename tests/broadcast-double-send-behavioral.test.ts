/* broadcastNotice (lib/actions/students.ts), exercised for REAL against a
   real Postgres test schema — not by reading source text. Found in the Oct
   2026 complaint/notification audit: the function had no idempotency guard
   at all — it read the student list, created one Notification row per
   student, then audited the send, with nothing serializing or deduping two
   near-simultaneous calls. A double-click on "Send broadcast" (or a client
   retry on a slow request, the same failure mode this codebase has already
   fixed for acceptOrder, placeOrder, resolveComplaint, etc. — see the
   playbook's concurrency-audit entries) would create TWO Notification rows
   and fire TWO web-push deliveries per student for what the staff member
   believed was a single campus-wide notice. Fixed with the same advisory-
   lock-then-fresh-recheck shape used everywhere else: a lock keyed to the
   sending staff member, with an inner check that an identical message
   wasn't already sent moments ago. This test fires two concurrent identical
   broadcasts and asserts exactly one goes out, not two. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.97" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_broadcast_double_send";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let students: typeof import("../lib/actions/students");

beforeAll(async () => {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: BASE.split("?")[0] });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await c.end();
  execSync("npx prisma db push", { cwd: path.resolve(__dirname, ".."), stdio: "ignore", env: { ...process.env, DATABASE_URL: TEST_URL } });

  db = (await import("../lib/db")).db;
  auth = await import("../lib/auth");
  students = await import("../lib/actions/students");

  await db.college.create({ data: { id: "col1", name: "Broadcast College", features: {} } });
  await db.student.create({ data: { id: "stu1", phone: "9000000011", name: "Broadcast Target 1", collegeId: "col1" } });
  await db.student.create({ data: { id: "stu2", phone: "9000000012", name: "Broadcast Target 2", collegeId: "col1" } });
}, 300_000);

describe("broadcastNotice can't be sent twice by a double-click/race", () => {
  it("two concurrent identical broadcasts from the same staff member result in exactly one delivery per student", async () => {
    const owner = await db.staff.create({ data: { phone: "9000000098", name: "Owner", role: 4, collegeId: null } });
    await auth.createSession({ mode: "staff", staffId: owner.id, role: 4, epoch: owner.sessionEpoch });

    const [r1, r2] = await Promise.all([
      students.broadcastNotice("col1", "Hostel water supply will be off 2-4pm today"),
      students.broadcastNotice("col1", "Hostel water supply will be off 2-4pm today"),
    ]);

    const oks = [r1, r2].filter((r) => r.ok);
    expect(oks.length).toBe(1); // exactly one of the two calls actually sent it

    const notifCount = await db.notification.count({
      where: { studentId: { in: ["stu1", "stu2"] }, text: "Hostel water supply will be off 2-4pm today" },
    });
    expect(notifCount).toBe(2); // one per student, not four (two students x two sends)
  });
});
