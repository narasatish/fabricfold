/* BVRIT and St Mary's are separate businesses, so the Google Sheet must keep
   them apart: per-college Live/Daily/Complaints/Staff tabs and per-college
   event logs (Orders/Payments/Collections/Complaint log). Source-grep tests,
   the house pattern for guards. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (f: string) => readFileSync(path.resolve(__dirname, "..", f), "utf8");

describe("per-college Sheet tabs", () => {
  const sync = read("lib/sheets-sync.ts");
  it("writes Live, Daily, Complaints and Staff once per college with a college-suffixed tab", () => {
    for (const t of ["Live", "Daily", "Complaints", "Staff"]) expect(sync).toContain(`writeSheet("${t}" + sfx`);
    expect(sync).toMatch(/scopeColleges = await db\.college\.findMany\(\{ where: \{ active: true \}/);
  });
  it("scopes the report and counts by college, not globally", () => {
    expect(sync).toMatch(/computeReport\(parsePeriod\(\{ p: "month" \}\), cid\)/);
    expect(sync).toMatch(/computeReport\(parsePeriod\(\{ p: "day", d \}\), cid\)/);
    expect(sync).toMatch(/where: cid \? \{ collegeId: cid \} : \{\}/);
  });
  it("keeps the day-close cash count off the campus staff tabs", () => {
    expect(sync).toMatch(/if \(!cid\) \{\s*staffRows\.push\(\[\], \["DAY CLOSE/);
  });
});

describe("per-college event logs", () => {
  const events = read("lib/sheet-events.ts");
  it("stores the campus on the outbox row and routes to '<Tab> — <College>'", () => {
    expect(events).toMatch(/collegeId: collegeId \?\? null/);
    expect(events).toMatch(/`\$\{base\} — \$\{collegeNames\.get\(cid\)\}`/);
  });
  it("every enqueueSheetEvent call site passes a college", () => {
    for (const f of ["lib/actions/orders.ts", "lib/actions/complaints.ts", "lib/actions/subscription.ts"]) {
      const src = read(f);
      const calls = src.split("enqueueSheetEvent(").slice(1);
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(c.slice(0, c.indexOf(");") + 2)).toMatch(/\], [a-z]+\.collegeId\);$/);
    }
  });
});
