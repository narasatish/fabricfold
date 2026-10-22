/* Owner request 2026-10-22: cancelling a PAID (real cash/UPI) order with no
   record of why is the same shape of fraud as skimming a refund — collect
   cash, cancel the order, pocket it. Damage complaints already required
   MIN_DAMAGE_PHOTOS; cancelOrder now requires the same evidence (a note +
   3+ photos) before it will cancel a paid cash/UPI order. An unpaid draft,
   or a cycle/redo "payment", stays exactly as unrestricted as before —
   this must not add friction to routine counter work. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.202" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const SCHEMA = "ff_cancel_paid_evidence";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let orders: typeof import("../lib/actions/orders");

beforeAll(async () => {
  if (!IS_PG) throw new Error("This test needs a real Postgres DATABASE_URL/DIRECT_URL.");
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
  auth = await import("../lib/auth");
  orders = await import("../lib/actions/orders");

  await db.college.create({ data: { id: "col1", name: "Test College", features: {} } });
  await db.student.create({ data: { id: "333333", phone: "9999900003", name: "Cancel Evidence Student", collegeId: "col1" } });
  const staff = await db.staff.create({ data: { phone: "9000000099", name: "Manager", role: 2, collegeId: "col1" } });
  await auth.createSession({ mode: "staff", staffId: staff.id, role: staff.role, epoch: staff.sessionEpoch });
}, 300_000);

let orderSeq = 0;
function mkOrder(opts: { paid: boolean; paymentMethod: string | null }) {
  const id = `CANCEV${++orderSeq}`;
  return db.order.create({
    data: {
      id, studentId: "333333", collegeId: "col1", service: "washIron",
      items: [{ label: "Garment", rate: 10, qty: 2 }],
      declaredPieces: 2, subtotal: 20, gst: 0, gstPctSnapshot: 0, total: 20,
      status: "received", paid: opts.paid, paymentMethod: opts.paymentMethod,
    },
  });
}

describe("cancelOrder requires evidence for a paid cash/UPI cancel, but not otherwise", () => {
  it("refuses with no note and no photos", async () => {
    const o = await mkOrder({ paid: true, paymentMethod: "cash" });
    const r = await orders.cancelOrder(o.id);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/describe why/i);
  });

  it("refuses with a note but fewer than 3 photos", async () => {
    const o = await mkOrder({ paid: true, paymentMethod: "upi" });
    const r = await orders.cancelOrder(o.id, { note: "Student changed their mind", photos: ["k1", "k2"] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/3 photos/i);
  });

  it("succeeds with a note and 3+ photos, and persists them on the order", async () => {
    const o = await mkOrder({ paid: true, paymentMethod: "cash" });
    const r = await orders.cancelOrder(o.id, { note: "Duplicate order placed by mistake", photos: ["k1", "k2", "k3"] });
    expect(r.ok).toBe(true);
    const after = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.status).toBe("cancelled");
    expect(after.cancelNote).toBe("Duplicate order placed by mistake");
    expect(after.cancelPhotos).toEqual(["k1", "k2", "k3"]);
  });

  it("does NOT require evidence for an unpaid order", async () => {
    const o = await mkOrder({ paid: false, paymentMethod: null });
    const r = await orders.cancelOrder(o.id);
    expect(r.ok).toBe(true);
  });

  it("does NOT require evidence for a paid-via-cycle order", async () => {
    const o = await mkOrder({ paid: true, paymentMethod: "cycle" });
    const r = await orders.cancelOrder(o.id);
    expect(r.ok).toBe(true);
  });

  it("does NOT require evidence for a paid-via-redo order", async () => {
    const o = await mkOrder({ paid: true, paymentMethod: "redo" });
    const r = await orders.cancelOrder(o.id);
    expect(r.ok).toBe(true);
  });
});
