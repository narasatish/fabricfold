/* Found during a deep security/edge-case pass (2026-11-23): collectOrder's
   pickup-code lookup never filtered on expiresAt, unlike the identical
   login-OTP lookup in auth.ts. A pickup code is created with a 7-day
   expiresAt (lib/actions/orders.ts's advanceStatus "ready" branch) but
   with no expiry filter it matched forever — the column was written and
   then silently never enforced. This proves the real collectOrder()
   against a live Postgres schema: an expired pickup code must be
   rejected, a still-valid one must keep working, and the Order ID
   fallback (not time-limited by design) must be unaffected either way. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.210" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const SCHEMA = "ff_collect_pickup_expiry";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let orders: typeof import("../lib/actions/orders");

let staff: { id: string; role: number; sessionEpoch: number };

beforeAll(async () => {
  if (!IS_PG) throw new Error("This test needs a real Postgres DATABASE_URL/DIRECT_URL.");
  const { Client } = await import("pg");
  const client = new Client({ connectionString: BASE.split("?")[0] });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await client.end();
  execSync("npx prisma db push", {
    cwd: path.resolve(__dirname, ".."), stdio: "ignore",
    env: { ...process.env, DATABASE_URL: TEST_URL },
  });
  db = (await import("../lib/db")).db;
  auth = await import("../lib/auth");
  orders = await import("../lib/actions/orders");

  await db.college.create({ data: { id: "col1", name: "Test College", features: {} } });
  await db.student.create({ data: { id: "555555", phone: "9999900005", name: "Collect Student", collegeId: "col1" } });
  staff = await db.staff.create({ data: { phone: "9000000060", name: "Counter", role: 1, collegeId: "col1" } });
}, 300_000);

let orderSeq = 0;
async function mkReadyOrder() {
  const id = `COLEXP${++orderSeq}`;
  return db.order.create({
    data: {
      id, studentId: "555555", collegeId: "col1", service: "washIron",
      items: [{ label: "Garment", rate: 10, qty: 1 }],
      declaredPieces: 1, subtotal: 10, gst: 0, gstPctSnapshot: 0, total: 10,
      status: "ready", paid: true, paymentMethod: "cash",
    },
  });
}

async function asStaff() {
  await auth.createSession({ mode: "staff", staffId: staff.id, role: staff.role, epoch: staff.sessionEpoch });
}

describe("collectOrder rejects an expired pickup code", () => {
  it("a pickup code past its expiresAt no longer matches", async () => {
    const o = await mkReadyOrder();
    await db.otp.create({
      data: { phone: "", purpose: "pickup", code: "1234", refId: o.id, expiresAt: new Date(Date.now() - 1000) },
    });
    await asStaff();
    const r = await orders.collectOrder(o.id, "1234");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/does not match/i);
    const refreshed = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(refreshed.status).toBe("ready");
  });

  it("a still-valid pickup code keeps working", async () => {
    const o = await mkReadyOrder();
    await db.otp.create({
      data: { phone: "", purpose: "pickup", code: "5678", refId: o.id, expiresAt: new Date(Date.now() + 7 * 86_400_000) },
    });
    await asStaff();
    const r = await orders.collectOrder(o.id, "5678");
    expect(r.ok).toBe(true);
    const refreshed = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(refreshed.status).toBe("collected");
  });

  it("the Order ID fallback still works even with an expired pickup code on the same order", async () => {
    const o = await mkReadyOrder();
    await db.otp.create({
      data: { phone: "", purpose: "pickup", code: "9999", refId: o.id, expiresAt: new Date(Date.now() - 1000) },
    });
    await asStaff();
    const r = await orders.collectOrder(o.id, o.id.slice(-4));
    expect(r.ok).toBe(true);
    const refreshed = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(refreshed.status).toBe("collected");
  });
});
