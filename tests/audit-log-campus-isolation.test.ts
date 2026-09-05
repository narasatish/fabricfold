/* CRITICAL campus-isolation bug found 2026-09-05: app/s/audit/page.tsx
   fetched EVERY college's AuditLog rows unconditionally and showed them to
   any Admin (role 3+), not just Owner — AuditLog has no collegeId column,
   so a campus-scoped Admin at one college could read the full refund/
   cancellation/compensation/admin-action history of every OTHER college.
   This is a source-check (page.tsx server components have no rendering
   harness in this suite, same as every other staff page.tsx test here —
   see deep-audit-fixes.test.ts's Reports-page checks for the precedent),
   but it directly locks in the fix's shape: filter by the ACTING STAFF
   MEMBER's own collegeId (the same signal assertSameCollege uses
   everywhere else), Owner (collegeId null) still sees everything. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");

describe("the staff Audit log page scopes rows to the viewing staff member's own campus", () => {
  const src = read("app/s/audit/page.tsx");

  it("fetches staff with collegeId and filters logs by the acting staff member's campus", () => {
    expect(src).toMatch(/select: \{ id: true, name: true, role: true, collegeId: true \}/);
    expect(src).toMatch(/const logs = staff\.collegeId\s*\n\s*\? allLogs\.filter\(\(l\) => staffById\.get\(l\.by\)\?\.collegeId === staff\.collegeId\)\s*\n\s*: allLogs;/);
  });

  it("an Owner (collegeId null) still sees every campus, unfiltered", () => {
    // The ternary's else-branch is `allLogs` (no filter) — already asserted
    // by the regex above; this test documents the intent explicitly so a
    // future edit that accidentally always-filters gets caught by name.
    expect(src).toMatch(/: allLogs;/);
  });
});
