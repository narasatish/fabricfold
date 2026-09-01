/* Named tools per staff member (owner, Sep 2026).

   "We can't provide sensitive data or anything related to accounting to
   staff." Roles stay the backbone; the perms map bends individuals. The
   holes this closed are pinned first, because they were real: ANY staff
   could open Reports, download the full transactions Excel, and refund
   money. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { staffCan, PERM_DEFS } from "../lib/perms";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");

describe("the defaults", () => {
  it("Counter (1) gets NO money tools by default", () => {
    const counter = { role: 1 };
    expect(staffCan(counter, "reports")).toBe(false);
    expect(staffCan(counter, "refunds")).toBe(false);
    expect(staffCan(counter, "dayclose")).toBe(false);
  });
  it("Manager (2) gets them all by default", () => {
    const mgr = { role: 2 };
    for (const k of Object.keys(PERM_DEFS) as (keyof typeof PERM_DEFS)[]) expect(staffCan(mgr, k)).toBe(true);
  });
});

describe("overrides", () => {
  it("a grant lifts a counter member into a tool", () => {
    expect(staffCan({ role: 1, perms: { refunds: true } }, "refunds")).toBe(true);
  });
  it("a revoke takes a tool from a manager", () => {
    expect(staffCan({ role: 2, perms: { reports: false } }, "reports")).toBe(false);
  });
  it("an owner cannot be revoked — no lockout footguns", () => {
    expect(staffCan({ role: 4, perms: { reports: false, refunds: false, dayclose: false } }, "reports")).toBe(true);
  });
  it("garbage in the map is ignored, not obeyed", () => {
    expect(staffCan({ role: 2, perms: { reports: "no" } }, "reports")).toBe(true);
    expect(staffCan({ role: 1, perms: null }, "refunds")).toBe(false);
  });
});

describe("the holes that were open", () => {
  it("refunds: was requireStaff(1) — any staff could give money back", () => {
    expect(read("lib/actions/orders.ts")).toMatch(/requireStaffPerm\("refunds"\)/);
  });
  it("compensation rides the refunds tool; cash still needs a Manager", () => {
    const src = read("lib/actions/credits.ts");
    expect(src).toMatch(/requireStaffPerm\("refunds"\)/);
    expect(src).toMatch(/Cash compensation needs a Manager/);
  });
  it("the transactions Excel needed only requireStaff(1)", () => {
    expect(read("app/api/export/xlsx/route.ts")).toMatch(/requireStaffPerm\("reports"\)/);
  });
  it("the Reports page let any staff see revenue", () => {
    const src = read("app/s/reports/page.tsx");
    expect(src).toMatch(/staffCan\(me, "reports"\)/);
    expect(src).toMatch(/redirect\("\/s"\)/);
  });
  it("the Admin page let any staff read payment config and phone numbers", () => {
    expect(read("app/s/admin/page.tsx")).toMatch(/gate\.role < 3/);
  });
  it("day close is the dayclose tool", () => {
    expect(read("lib/actions/ops.ts")).toMatch(/requireStaffPerm\("dayclose"\)/);
  });
});

describe("the tab bar tells the truth", () => {
  it("no Reports tab for staff who cannot open it", () => {
    const src = read("app/s/_components/StaffTabBar.tsx");
    expect(src).toMatch(/canReports \?/);
  });
  it("the layout computes it from the same staffCan the page enforces", () => {
    expect(read("app/s/layout.tsx")).toMatch(/staffCan\(staff, "reports"\)/);
  });
});

describe("the admin can actually turn the switches", () => {
  it("saveStaff stores only known keys with real booleans", () => {
    const src = read("lib/actions/admin.ts");
    expect(src).toMatch(/k in PERM_DEFS && typeof v === "boolean"/);
  });
  it("changes are audited as +tool/-tool", () => {
    expect(read("lib/actions/admin.ts")).toMatch(/\$\{v \? "\+" : "-"\}\$\{k\}/);
  });
  it("the staff sheet shows the switches, role default named, owners exempt", () => {
    const ui = read("app/s/admin/_components/AdminClient.tsx");
    expect(ui).toMatch(/stEdit\.role < 4 && \(/);
    expect(ui).toMatch(/overridden" : " · role default/);
  });
});

describe("requireStaffPerm", () => {
  it("names the missing tool and who can fix it", () => {
    expect(read("lib/auth.ts")).toMatch(/doesn't have "\$\{PERM_DEFS\[key\]\.label\}" — ask the owner/);
  });
});
