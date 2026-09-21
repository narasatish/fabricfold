/* Behavioral test (real actions, real test DB) for saveStaff's owner protection
   and input checks. Found in the Sep 21 testing pass: setStaffActive stops an
   Admin removing an Owner and stops removing the last Owner, but saveStaff had
   neither guard - an Admin could demote or rewrite an Owner's account, the last
   Owner could be demoted (leaving nobody able to grant Owner again), and any
   role number / phone / name length was accepted. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.99" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_staff_guard";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let admin: typeof import("../lib/actions/admin");
let auth: typeof import("../lib/auth");

beforeAll(async () => {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: BASE.split("?")[0] });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await c.end();
  execSync("npx prisma db push", { cwd: path.resolve(__dirname, ".."), stdio: "ignore", env: { ...process.env, DATABASE_URL: TEST_URL } });
  db = (await import("../lib/db")).db;
  admin = await import("../lib/actions/admin");
  const authLib = await import("../lib/auth");
  auth = authLib;
  await db.college.create({ data: { id: "col1", name: "Fuzz College", features: {} } });
  await db.staff.create({ data: { id: "own1", phone: "9000000030", name: "Owner One", role: 4, active: true, collegeId: null } });
  await db.staff.create({ data: { id: "own2", phone: "9000000031", name: "Owner Two", role: 4, active: true, collegeId: null } });
  await db.staff.create({ data: { id: "adm1", phone: "9000000032", name: "Global Admin", role: 3, active: true, collegeId: null } });
  await db.staff.create({ data: { id: "wrk1", phone: "9000000033", name: "Worker", role: 1, active: true, collegeId: "col1" } });
}, 300_000);

const as = async (id: string, role: number) => { await auth.createSession({ mode: "staff", staffId: id, role, epoch: 0 }); };
const edit = (id: string, over: Record<string, unknown> = {}) =>
  admin.saveStaff({ id, name: "Edited", phone: "9111111111", role: 1, collegeId: null, ...over } as never);

describe("an Admin cannot touch an Owner's account", () => {
  it("refuses to demote or rewrite an owner, and changes nothing", async () => {
    await as("adm1", 3);
    const r = await edit("own2", { role: 3 });
    expect(r.ok).toBe(false);
    const o = await db.staff.findUniqueOrThrow({ where: { id: "own2" } });
    expect([o.role, o.name, o.phone]).toEqual([4, "Owner Two", "9000000031"]);
  });
});

describe("owners can't erase the last owner", () => {
  it("an owner may demote a different owner while another remains", async () => {
    await as("own1", 4);
    expect((await edit("own2", { role: 3, name: "Owner Two", phone: "9000000031" })).ok).toBe(true);
  });
  it("but the LAST active owner cannot be demoted", async () => {
    await as("own1", 4);
    const r = await edit("own1", { role: 3, name: "Owner One", phone: "9000000030" });
    expect(r.ok).toBe(false);
    expect((await db.staff.findUniqueOrThrow({ where: { id: "own1" } })).role).toBe(4);
  });
});

describe("saveStaff input checks", () => {
  const bad: [string, Record<string, unknown>][] = [
    ["role 0", { role: 0 }], ["role 9", { role: 9 }], ["role NaN", { role: NaN }], ["role 2.5", { role: 2.5 }],
    ["phone starting 1", { phone: "1234567890" }], ["phone all zeros", { phone: "0000000000" }],
    ["300-char name", { name: "N".repeat(300) }], ["blank name", { name: "   " }],
  ];
  for (const [label, over] of bad) {
    it(`rejects ${label}`, async () => {
      await as("own1", 4);
      const r = await edit("wrk1", over);
      expect(r.ok, label).toBe(false);
      const w = await db.staff.findUniqueOrThrow({ where: { id: "wrk1" } });
      expect([w.role, w.name]).toEqual([1, "Worker"]);
    });
  }
  it("still edits a normal worker", async () => {
    await as("own1", 4);
    expect((await edit("wrk1", { name: "Worker Renamed", phone: "9222222222", role: 2, collegeId: "col1" })).ok).toBe(true);
  });
});

describe("saveCollege input checks", () => {
  const college = (over: Record<string, unknown> = {}) =>
    admin.saveCollege({ name: "Test Campus", address: "Somewhere", closedWeekday: 4, ...over } as never);
  const bad: [string, Record<string, unknown>][] = [
    ["closed weekday 9", { closedWeekday: 9 }], ["closed weekday 2.5", { closedWeekday: 2.5 }], ["closed weekday NaN", { closedWeekday: NaN }],
    ["closed weekday -1", { closedWeekday: -1 }], ["300-char name", { name: "C".repeat(300) }], ["blank name", { name: "  " }],
    ["500-char address", { address: "a".repeat(500) }],
  ];
  for (const [label, over] of bad) {
    it(`rejects ${label}`, async () => {
      await as("own1", 4);
      const before = await db.college.count();
      const r = await college(over);
      expect(r.ok, label).toBe(false);
      expect(await db.college.count()).toBe(before);
    });
  }
  it("an unknown college id returns an error instead of throwing", async () => {
    await as("own1", 4);
    const r = await college({ id: "does-not-exist" });
    expect(r.ok).toBe(false);
  });
  it("still adds a normal college, and accepts 'no closed day'", async () => {
    await as("own1", 4);
    expect((await college({ name: "Real Campus", closedWeekday: null })).ok).toBe(true);
  });
});

describe("registerStudent / updateStudentPhone input checks", () => {
  const reg = (over: Record<string, unknown> = {}) =>
    admin.registerStudent({ name: "New Kid", phone: "9811111111", collegeId: "col1", ...over } as never);
  const bad: [string, Record<string, unknown>][] = [
    ["phone starting 1", { phone: "1234567890" }], ["phone all zeros", { phone: "0000000000" }], ["9-digit phone", { phone: "981111111" }],
    ["300-char name", { name: "N".repeat(300) }], ["1-char name", { name: "A" }], ["blank name", { name: "   " }],
  ];
  for (const [label, over] of bad) {
    it(`registerStudent rejects ${label}`, async () => {
      await as("own1", 4);
      const before = await db.student.count();
      const r = await reg(over);
      expect(r.ok, label).toBe(false);
      expect(await db.student.count()).toBe(before);
    });
  }
  it("still registers a normal student, with punctuation in the number", async () => {
    await as("own1", 4);
    expect((await reg({ phone: "+91 98111 22222", name: "Real Kid" })).ok).toBe(true);
    expect(await db.student.count({ where: { phone: "9811122222" } })).toBe(1);
  });
  it("updateStudentPhone rejects a number that can't be a real mobile", async () => {
    await as("own1", 4);
    const s = await db.student.findFirstOrThrow({ where: { phone: "9811122222" } });
    for (const p of ["1234567890", "0000000000"]) expect((await admin.updateStudentPhone(s.id, p)).ok, p).toBe(false);
    expect((await db.student.findUniqueOrThrow({ where: { id: s.id } })).phone).toBe("9811122222");
    expect((await admin.updateStudentPhone(s.id, "9822233333")).ok).toBe(true);
  });
});
