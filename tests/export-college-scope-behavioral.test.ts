/* Behavioral test (real route, real DB, real .xlsx parsed): the Excel exports must
   respect the college being viewed. Found in the Sep 21 QA pass: the Reports page
   showed one college (?c=) but the export links dropped it and the route only
   scoped by the staff member's OWN college, so an owner viewing BVRIT downloaded
   a file with BOTH colleges mixed together. */
import ExcelJS from "exceljs";
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.100" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_export_scope";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let route: typeof import("../app/api/export/xlsx/route");
let auth: typeof import("../lib/auth");

beforeAll(async () => {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: BASE.split("?")[0] });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await c.end();
  execSync("npx prisma db push", { cwd: path.resolve(__dirname, ".."), stdio: "ignore", env: { ...process.env, DATABASE_URL: TEST_URL } });
  db = (await import("../lib/db")).db;
  route = await import("../app/api/export/xlsx/route");
  const authLib = await import("../lib/auth");
  auth = authLib;
  await db.appConfig.create({ data: { id: "main", gstPct: 18, plan: {}, rates: {}, payment: {}, settings: {} } });
  await db.college.create({ data: { id: "bv", name: "BVRIT", features: {} } });
  await db.college.create({ data: { id: "sm", name: "St Mary's", features: {} } });
  await db.staff.create({ data: { id: "own1", phone: "9000000040", name: "Owner", role: 4, active: true, collegeId: null } });
  await db.staff.create({ data: { id: "smadm", phone: "9000000041", name: "SM Admin", role: 3, active: true, collegeId: "sm" } });
  await db.student.create({ data: { id: "s_bv", phone: "9000000042", name: "Bv Kid", collegeId: "bv" } });
  await db.student.create({ data: { id: "s_sm", phone: "9000000043", name: "Sm Kid", collegeId: "sm" } });
  await db.payment.create({ data: { id: "p_bv", method: "upi", amount: 111, collegeId: "bv", studentId: "s_bv", note: "bv-pay" } });
  await db.payment.create({ data: { id: "p_sm", method: "cash", amount: 222, collegeId: "sm", studentId: "s_sm", note: "sm-pay" } });
  await db.expense.create({ data: { category: "Soap", amount: 50, note: "bv-exp", method: "cash", by: "own1", collegeId: "bv" } });
  await db.expense.create({ data: { category: "Power", amount: 60, note: "sm-exp", method: "cash", by: "own1", collegeId: "sm" } });
}, 300_000);

const as = async (id: string, role: number) => { await auth.createSession({ mode: "staff", staffId: id, role, epoch: 0 }); };
const cells = async (res: Response) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await res.arrayBuffer());
  const out: string[] = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => out.push(String(c.value ?? "")))));
  return out.join("|");
};
const get = (qs: string) => route.GET(new Request("http://localhost/api/export/xlsx?" + qs));

describe("Excel export respects the college", () => {
  it("owner + c=bv: only BVRIT's rows, and the file/summary say which college", async () => {
    await as("own1", 4);
    const res = await get("p=all&type=full&c=bv");
    expect(res.status).toBe(200);
    const t = await cells(res);
    expect(t).toContain("bv-pay"); expect(t).toContain("bv-exp");
    expect(t).not.toContain("sm-pay"); expect(t).not.toContain("sm-exp"); expect(t).not.toContain("Sm Kid");
    expect(t).toContain("BVRIT");
    expect(res.headers.get("content-disposition")).toMatch(/bvrit/i);
  });
  it("owner + c=sm: only St Mary's rows", async () => {
    await as("own1", 4);
    const t = await cells(await get("p=all&type=full&c=sm"));
    expect(t).toContain("sm-pay"); expect(t).toContain("sm-exp");
    expect(t).not.toContain("bv-pay"); expect(t).not.toContain("bv-exp");
  });
  it("owner with no college chosen: the combined view still has both", async () => {
    await as("own1", 4);
    const t = await cells(await get("p=all&type=full"));
    expect(t).toContain("bv-pay"); expect(t).toContain("sm-pay");
  });
  it("a campus-scoped admin can't export another college by editing ?c=", async () => {
    await as("smadm", 3);
    const t = await cells(await get("p=all&type=full&c=bv"));
    expect(t).toContain("sm-pay"); expect(t).not.toContain("bv-pay"); expect(t).not.toContain("bv-exp");
  });
  it("an unknown college id is refused, not silently treated as 'everything'", async () => {
    await as("own1", 4);
    expect((await get("p=all&type=full&c=does-not-exist")).status).toBe(400);
  });
});

describe("the Reports page passes the college into the export links", () => {
  it("qs() includes the selected college", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../app/s/reports/page.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/selectedCollegeId \? \{ c: selectedCollegeId \}/);
  });
});
