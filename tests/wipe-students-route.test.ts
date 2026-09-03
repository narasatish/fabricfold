/* Pre-import reset: clear every demo/test student before the real Excel
   roster goes in. Same guard shape as the earlier one-off launch wipe —
   Owner-only, explicit confirm phrase, and this route is deleted the moment
   it has run once. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const src = read("app/api/admin/wipe-students/route.ts");

describe("guards", () => {
  it("Owner only", () => {
    expect(src).toMatch(/requireStaff\(4\)/);
  });
  it("refuses without the exact confirm phrase", () => {
    expect(src).toMatch(/confirm !== "WIPE ALL STUDENTS"/);
  });
  it("lowers the ledger protection only inside this transaction", () => {
    expect(src).toMatch(/set_config\('app\.allow_delete', 'on', true\)/);
  });
});

describe("what it does", () => {
  it("deletes every student, not a subset", () => {
    expect(src).toMatch(/\["student", \(\) => tx\.student\.deleteMany\(\{\}\)\]/);
  });
  it("children go before the parent — Order/Payment/Bag/Subscription all precede Student", () => {
    const studentAt = src.indexOf('["student", () => tx.student.deleteMany');
    for (const child of ['["order",', '["payment",', '["bag",', '["subscription",']) {
      expect(src.indexOf(child)).toBeLessThan(studentAt);
    }
  });
  it("resets FySequence so invoice/bag numbering starts clean with the real roster", () => {
    expect(src).toMatch(/\["fySequence", \(\) => tx\.fySequence\.deleteMany\(\{\}\)\]/);
  });
  it("is audited", () => {
    expect(src).toMatch(/"All students wiped"/);
  });
  it("does NOT touch Staff — this wipes students, not the team", () => {
    expect(src).not.toMatch(/tx\.staff\.deleteMany/);
  });
});

describe("the Sheet and a diagnostic report", () => {
  it("refreshes the Sheet immediately, and a failed write cannot fail the wipe", () => {
    expect(src).toMatch(/await runRosterSync\(\); sheetSynced = true/);
    expect(src).toMatch(/catch \{ \/\* the app remains correct even if the Sheet write fails \*\/ \}/);
  });
  it("returns the live Staff table — the only way to see Mumbai's real data right now", () => {
    // vercel env pull returns DATABASE_URL blank for the Supabase integration
    expect(src).toMatch(/const staffReport = await db\.staff\.findMany/);
    expect(src).toMatch(/staff: staffReport/);
  });
});
