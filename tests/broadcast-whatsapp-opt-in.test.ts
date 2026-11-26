/* broadcastNotice's WhatsApp fan-out (lib/actions/students.ts, added
   2026-11 alongside a performance pass) — opt-in per send via a third
   `viaWhatsApp` argument, defaulting to false. Owner: keep WhatsApp
   broadcasts to account/order-related notices only, since they route
   through the same approved UTILITY template every order-status message
   already uses (sendWhatsApp, lib/notify.ts) — a general announcement or
   promotion through a utility template risks Meta restricting the
   business number. There's no reliable way to classify a message's
   content automatically, so the UI (StudentsClient.tsx) carries that
   warning instead; this test only proves the ON/OFF switch itself works
   and reaches every student in scope exactly once. */
import "dotenv/config";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";

const sendWhatsAppCalls: { phone: string; text: string }[] = [];
vi.mock("../lib/notify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/notify")>();
  return {
    ...actual,
    sendWhatsApp: vi.fn(async (phone: string, text: string) => {
      sendWhatsAppCalls.push({ phone, text });
    }),
  };
});

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.99" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_broadcast_whatsapp_optin";
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

  await db.college.create({ data: { id: "col1", name: "WhatsApp Opt-in College", features: {} } });
  await db.student.create({ data: { id: "wstu1", phone: "9000000021", name: "WA Target 1", collegeId: "col1" } });
  await db.student.create({ data: { id: "wstu2", phone: "9000000022", name: "WA Target 2", collegeId: "col1" } });
}, 300_000);

const asOwner = async () => {
  cookieJar.clear();
  const owner = await db.staff.create({ data: { phone: "90000000" + Math.floor(Math.random() * 90 + 10), name: "Owner", role: 4, collegeId: null } });
  await auth.createSession({ mode: "staff", staffId: owner.id, role: 4, epoch: owner.sessionEpoch });
};

describe("broadcastNotice's viaWhatsApp opt-in", () => {
  it("defaults OFF — a plain broadcast never touches WhatsApp", async () => {
    await asOwner();
    sendWhatsAppCalls.length = 0;
    const r = await students.broadcastNotice("col1", "Plain notice, no WhatsApp");
    expect(r.ok).toBe(true);
    expect(sendWhatsAppCalls.length).toBe(0);
  });

  it("when true, reaches every student in scope exactly once, with the same text", async () => {
    await asOwner();
    sendWhatsAppCalls.length = 0;
    const r = await students.broadcastNotice("col1", "Your subscription expires in 3 days", true);
    expect(r.ok).toBe(true);
    expect(sendWhatsAppCalls.length).toBe(2);
    const phones = sendWhatsAppCalls.map((c) => c.phone).sort();
    expect(phones).toEqual(["9000000021", "9000000022"]);
    for (const c of sendWhatsAppCalls) expect(c.text).toBe("Your subscription expires in 3 days");
  });

  it("a campus-scoped broadcast only reaches that campus's students over WhatsApp too", async () => {
    await db.college.create({ data: { id: "col2", name: "Other WA College", features: {} } });
    await db.student.create({ data: { id: "wstu3", phone: "9000000023", name: "Other Campus", collegeId: "col2" } });
    await asOwner();
    sendWhatsAppCalls.length = 0;
    const r = await students.broadcastNotice("col1", "Scoped WhatsApp test", true);
    expect(r.ok).toBe(true);
    expect(sendWhatsAppCalls.map((c) => c.phone).sort()).toEqual(["9000000021", "9000000022"]);
  });
});
