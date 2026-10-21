/* POST /api/report/daily ("Email today's report" button in the Reports
   screen) is gated only by `requireStaff(2)` — a bare role floor. The
   Reports PAGE itself (app/s/reports/page.tsx) correctly redirects anyone
   without `staffCan(me, "reports")` before it even renders, matching the
   xlsx export route (app/api/export/xlsx/route.ts), which calls
   `requireStaffPerm("reports")` on the API side too — not just hidden in
   the UI, the exact standard this codebase holds every other money-report
   surface to.

   `report/daily` never got that second check: a Manager (role 2) whose
   "reports" tool the owner explicitly revoked is correctly bounced from
   the Reports page UI, but can still POST directly to this route, trigger
   the real owner-report email send, and learn the configured report
   destination address from the JSON response — the exact "money reports &
   exports" category the "reports" tool exists to gate (lib/perms.ts:
   "Revenue, GST, drawer figures, Excel downloads"), bypassed by going
   straight to the API instead of through the page. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.93" }),
}));

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => {}) }));
vi.mock("@/lib/notify", async () => {
  const actual = await vi.importActual<typeof import("../lib/notify")>("../lib/notify");
  return { ...actual, notifyOwnersWhatsApp: vi.fn(async () => {}) };
});

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_report_daily_perm";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let route: typeof import("../app/api/report/daily/route");

beforeAll(async () => {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: BASE.split("?")[0] });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await c.end();
  execSync("npx prisma db push", { cwd: path.resolve(__dirname, ".."), stdio: "ignore", env: { ...process.env, DATABASE_URL: TEST_URL } });

  db = (await import("../lib/db")).db;
  auth = await import("../lib/auth");
  route = await import("../app/api/report/daily/route");

  await db.appConfig.create({
    data: {
      id: "main", gstPct: 18,
      plan: { price: 6800, cycles: 34, kgPerCycle: 7 },
      rates: { wash: { label: "Wash & Fold", items: [["Shirt", 20]] } },
      payment: { upiId: "ff@test", payeeName: "Test", bankName: "", accountName: "", accountNo: "", ifsc: "", gatewayKey: "" },
      settings: { reportEmail: "owner-secret@example.com", dailyEmail: false, sendHour: 21, lastSent: null, openingFloat: 0 },
    },
  });
  await db.college.create({ data: { id: "col1", name: "Report Daily Perm College", features: {} } });
}, 300_000);

describe("POST /api/report/daily requires the 'reports' tool, not just role >= 2", () => {
  it("a Manager with 'reports' explicitly revoked is refused", async () => {
    const mgr = await db.staff.create({
      data: { phone: "9000000201", name: "Revoked Reports Manager", role: 2, collegeId: "col1", perms: { reports: false } },
    });
    await auth.createSession({ mode: "staff", staffId: mgr.id, role: 2, epoch: 0 });

    const res = await route.POST();
    expect(res.status).toBe(401);
  });

  it("a Manager with 'reports' granted (the default) can still trigger it", async () => {
    const mgr = await db.staff.create({
      data: { phone: "9000000202", name: "Normal Reports Manager", role: 2, collegeId: "col1" },
    });
    await auth.createSession({ mode: "staff", staffId: mgr.id, role: 2, epoch: 0 });

    const res = await route.POST();
    expect(res.status).toBe(200);
  });

  it("a Counter member (role 1, below the tool's own default floor) is refused", async () => {
    const counter = await db.staff.create({
      data: { phone: "9000000203", name: "Counter", role: 1, collegeId: "col1" },
    });
    await auth.createSession({ mode: "staff", staffId: counter.id, role: 1, epoch: 0 });

    const res = await route.POST();
    expect(res.status).toBe(401);
  });
});
