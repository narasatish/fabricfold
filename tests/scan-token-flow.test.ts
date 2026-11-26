/* The counter flow redesign (owner, 2026-11): students no longer place
   their own orders — staff create the order at the counter after scanning
   a one-time QR code from the student's profile (createScanCode), and the
   SAME kind of scan is used again at pickup, where staff just mark the
   order delivered with no separate pickup code. This file proves, against
   a real Postgres schema:
     1. placeOrder is a hard dead end for every student now, not just a
        hidden button.
     2. createScanCode mints a token that resolves to the right student
        exactly once, and never again (single-use) or after it expires.
     3. collectOrder no longer needs a code — a staff member landed on a
        "ready" order can mark it delivered with nothing but their own
        auth + same-college check. */
import "dotenv/config";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";

const redirectCalls: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirectCalls.push(url);
    throw new Error("NEXT_REDIRECT:" + url);
  },
}));

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.95" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const SCHEMA = "ff_scan_token_flow";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let orders: typeof import("../lib/actions/orders");
let students: typeof import("../lib/actions/students");
let scanPage: typeof import("../app/s/scan/[id]/page").default;

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
  students = await import("../lib/actions/students");
  scanPage = (await import("../app/s/scan/[id]/page")).default;

  await db.college.create({ data: { id: "colA", name: "Scan College", features: {}, active: true } });
  await db.college.create({ data: { id: "colB", name: "Other College", features: {}, active: true } });
  await db.staff.create({ data: { id: "staffA", phone: "9000000070", name: "Counter A", role: 1, collegeId: "colA" } });
  await db.staff.create({ data: { id: "staffB", phone: "9000000071", name: "Counter B", role: 1, collegeId: "colB" } });
}, 300_000);

const asStudent = async (studentId: string) => {
  cookieJar.clear();
  const stu = await db.student.findUniqueOrThrow({ where: { id: studentId } });
  await auth.createSession({ mode: "customer", studentId, epoch: stu.sessionEpoch });
};
const asStaff = async (staffId: string) => {
  cookieJar.clear();
  const staff = await db.staff.findUniqueOrThrow({ where: { id: staffId } });
  await auth.createSession({ mode: "staff", staffId, role: staff.role, epoch: staff.sessionEpoch });
};

describe("placeOrder is permanently disabled", () => {
  it("refuses even a well-formed request from a signed-in student", async () => {
    const s = await db.student.create({ data: { id: "611001", phone: "9999911001", name: "No Self Orders", collegeId: "colA", credits: 0 } });
    await asStudent(s.id);
    const r = await orders.placeOrder({ service: "washIron", items: [{ label: "Garment", qty: 2 }], express: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/staff/i);
    expect(await db.order.count({ where: { studentId: s.id } })).toBe(0);
  });
});

describe("createScanCode + the /s/scan/[id] route", () => {
  it("a fresh token resolves to the right student and redirects staff there", async () => {
    const s = await db.student.create({ data: { id: "611002", phone: "9999911002", name: "Scan Me", collegeId: "colA", credits: 0 } });
    await asStudent(s.id);
    const code = await students.createScanCode();
    expect(code.ok).toBe(true);
    if (!code.ok) return;

    await asStaff("staffA");
    await expect(scanPage({ params: Promise.resolve({ id: code.token }) })).rejects.toThrow(/NEXT_REDIRECT:\/s\/customers\/611002/);
  });

  it("the same token cannot be scanned twice", async () => {
    const s = await db.student.create({ data: { id: "611003", phone: "9999911003", name: "One Shot", collegeId: "colA", credits: 0 } });
    await asStudent(s.id);
    const code = await students.createScanCode();
    if (!code.ok) throw new Error("setup failed");

    await asStaff("staffA");
    await expect(scanPage({ params: Promise.resolve({ id: code.token }) })).rejects.toThrow(/NEXT_REDIRECT:\/s\/customers\/611003/);
    redirectCalls.length = 0;
    await expect(scanPage({ params: Promise.resolve({ id: code.token }) })).rejects.toThrow(/NEXT_REDIRECT:\/s\/scan\?error=expired/);
  });

  it("an expired token is refused even though it was never scanned", async () => {
    const s = await db.student.create({ data: { id: "611004", phone: "9999911004", name: "Stale Code", collegeId: "colA", credits: 0 } });
    const token = "deadbeefdeadbeefdeadbeefdeadbeef";
    await db.otp.create({ data: { phone: s.phone, purpose: "scan", code: token, refId: s.id, expiresAt: new Date(Date.now() - 1000) } });

    await asStaff("staffA");
    await expect(scanPage({ params: Promise.resolve({ id: token }) })).rejects.toThrow(/NEXT_REDIRECT:\/s\/scan\?error=expired/);
  });

  it("a garbage/forged token never leaks which student ids are valid", async () => {
    await asStaff("staffA");
    await expect(scanPage({ params: Promise.resolve({ id: "not-a-real-token" }) })).rejects.toThrow(/NEXT_REDIRECT:\/s\/scan\?error=expired/);
  });

  it("staff at a different college cannot ride a scan across colleges", async () => {
    const s = await db.student.create({ data: { id: "611005", phone: "9999911005", name: "Cross College", collegeId: "colA", credits: 0 } });
    await asStudent(s.id);
    const code = await students.createScanCode();
    if (!code.ok) throw new Error("setup failed");

    await asStaff("staffB"); // belongs to colB
    await expect(scanPage({ params: Promise.resolve({ id: code.token }) })).rejects.toThrow(/NEXT_REDIRECT:\/s\/students/);
  });
});

describe("collectOrder without a code", () => {
  const makeReadyOrder = async (studentId: string, collegeId: string) => {
    return db.order.create({
      data: {
        id: "RDY" + studentId, studentId, collegeId, service: "washFold",
        items: [{ label: "Shirt", rate: 20, qty: 2 }], declaredPieces: 2,
        subtotal: 40, gst: 0, gstPctSnapshot: 0, total: 40, status: "ready", paid: true,
      },
    });
  };

  it("a plain call with no code marks a ready order delivered", async () => {
    const s = await db.student.create({ data: { id: "611006", phone: "9999911006", name: "Ready Pickup", collegeId: "colA", credits: 0 } });
    const o = await makeReadyOrder(s.id, "colA");
    await asStaff("staffA");
    const r = await orders.collectOrder(o.id);
    expect(r.ok).toBe(true);
    const after = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.status).toBe("collected");
  });

  it("still refuses an order that isn't ready yet", async () => {
    const s = await db.student.create({ data: { id: "611007", phone: "9999911007", name: "Not Ready", collegeId: "colA", credits: 0 } });
    const o = await db.order.create({
      data: {
        id: "NRD" + s.id, studentId: s.id, collegeId: "colA", service: "washFold",
        items: [{ label: "Shirt", rate: 20, qty: 2 }], declaredPieces: 2,
        subtotal: 40, gst: 0, gstPctSnapshot: 0, total: 40, status: "processing", paid: true,
      },
    });
    await asStaff("staffA");
    const r = await orders.collectOrder(o.id);
    expect(r.ok).toBe(false);
  });

  it("a stale/wrong code passed in no longer matters once an order is actually ready — but a WRONG code is still refused if the caller bothers to send one", async () => {
    const s = await db.student.create({ data: { id: "611008", phone: "9999911008", name: "Wrong Code", collegeId: "colA", credits: 0 } });
    const o = await makeReadyOrder(s.id, "colA");
    await asStaff("staffA");
    const r = await orders.collectOrder(o.id, "0000");
    expect(r.ok).toBe(false);
  });
});
