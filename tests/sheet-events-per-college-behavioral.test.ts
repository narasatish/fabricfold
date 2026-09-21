/* Behavioral test (real DB, mocked Google): the live event log must route each
   college's rows to its OWN tab — "Orders — BVRIT" vs "Orders — St Mary's" —
   so the two businesses never share a log. Also proves a failed append for one
   college's tab doesn't mark the other college's rows sent (or lose them), and
   that legacy rows with no college still land in the base tab. */
import "dotenv/config";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";

const appended: { tab: string; rows: unknown[][] }[] = [];
let failTab: string | null = null;
vi.mock("../lib/sheets", () => ({
  sheetsConfigured: () => true,
  appendSheet: async (tab: string, rows: unknown[][]) => {
    if (tab === failTab) return { ok: false as const, error: "boom" };
    appended.push({ tab, rows });
    return { ok: true as const, rows: rows.length };
  },
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_sheet_events_college";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let ev: typeof import("../lib/sheet-events");

beforeAll(async () => {
  const { Client } = await import("pg");
  const admin = new Client({ connectionString: BASE.split("?")[0] });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await admin.end();
  execSync("npx prisma db push", { cwd: path.resolve(__dirname, ".."), stdio: "ignore", env: { ...process.env, DATABASE_URL: TEST_URL } });
  db = (await import("../lib/db")).db;
  ev = await import("../lib/sheet-events");
  await db.college.create({ data: { id: "bv", name: "BVRIT", features: {} } });
  await db.college.create({ data: { id: "sm", name: "St Mary's", features: {} } });
  await db.college.create({ data: { id: "sl", name: "A/B Campus", features: {} } });
}, 300_000);

const tabs = () => appended.map((a) => a.tab).sort();

describe("sheet events are routed per college", () => {
  it("sends each college's rows to its own tab, legacy rows to the base tab", async () => {
    appended.length = 0;
    await ev.enqueueSheetEvent(db, "order", ["t", "#1", "V1", "BV kid"], "bv");
    await ev.enqueueSheetEvent(db, "order", ["t", "#2", "S1", "SM kid"], "sm");
    await ev.enqueueSheetEvent(db, "payment", ["t", "#2", "S1", "SM kid", "upi", 100], "sm");
    await ev.enqueueSheetEvent(db, "complaint", ["t", "#1", "V1", "BV kid", "x", 0, "student"], "bv");
    await ev.enqueueSheetEvent(db, "collection", ["t", "#9", "?", "old"]); // no college (legacy)
    const r = await ev.flushSheetOutbox();
    expect(r.ok && r.sent).toBe(5);
    expect(tabs()).toEqual(["Collections", "Complaint log — BVRIT", "Orders — BVRIT", "Orders — St Mary's", "Payments — St Mary's"]);
    // rows landed in the right college's tab, not mixed
    expect(appended.find((a) => a.tab === "Orders — BVRIT")!.rows.map((x) => x[3])).toEqual(["BV kid"]);
    expect(appended.find((a) => a.tab === "Orders — St Mary's")!.rows.map((x) => x[3])).toEqual(["SM kid"]);
    expect(await db.sheetOutbox.count({ where: { sentAt: null } })).toBe(0);
  });

  it("a '/' in a college name can't break the tab name", async () => {
    appended.length = 0;
    await ev.enqueueSheetEvent(db, "order", ["t", "#3", "?", "slash"], "sl");
    await ev.flushSheetOutbox();
    expect(tabs()).toEqual(["Orders — A-B Campus"]);
  });

  it("a failed append for one college leaves the other college's rows sent and the failed ones queued", async () => {
    appended.length = 0;
    failTab = "Orders — BVRIT";
    await ev.enqueueSheetEvent(db, "order", ["t", "#4", "V1", "BV fail"], "bv");
    await ev.enqueueSheetEvent(db, "order", ["t", "#5", "S1", "SM ok"], "sm");
    const r = await ev.flushSheetOutbox();
    expect(r.ok && r.sent).toBe(1);
    expect(r.ok && r.failed).toBe(1);
    expect(tabs()).toEqual(["Orders — St Mary's"]);
    const left = await db.sheetOutbox.findMany({ where: { sentAt: null } });
    expect(left).toHaveLength(1);
    expect(left[0].collegeId).toBe("bv");
    expect(left[0].attempts).toBe(1);

    failTab = null; // Google recovers: the queued BVRIT row is delivered next sweep
    appended.length = 0;
    await ev.flushSheetOutbox();
    expect(tabs()).toEqual(["Orders — BVRIT"]);
    expect(await db.sheetOutbox.count({ where: { sentAt: null } })).toBe(0);
  });
});
