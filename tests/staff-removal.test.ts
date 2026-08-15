/* Removing a staff login.

   Every guard here is a way to lock the business out of its own admin panel,
   and none of them can be undone from inside the app once it has happened —
   so they are pinned rather than left to code review. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const admin = read("lib/actions/admin.ts");

describe("removal is deactivation, not deletion", () => {
  it("never calls delete on a staff row", () => {
    // payslips and attendance reference staff, and their id is on every
    // payment they took — deleting would break the record of who handled money
    expect(admin).not.toMatch(/staff\.delete\(/);
    expect(admin).not.toMatch(/staff\.deleteMany\(/);
  });

  it("flips `active` and is audited both ways", () => {
    expect(admin).toMatch(/setStaffActive/);
    expect(admin).toMatch(/audit\(active \? "Staff restored" : "Staff removed"/);
  });

  it("is restorable, so removing the wrong person is recoverable", () => {
    expect(admin).toMatch(/setStaffActive\(staffId: string, active: boolean\)/);
  });
});

describe("lockout guards", () => {
  it("requires Admin or above", () => {
    const fn = admin.slice(admin.indexOf("export async function setStaffActive"));
    expect(fn).toMatch(/requireStaff\(3\)/);
  });

  it("refuses to remove yourself", () => {
    expect(admin).toMatch(/You can't remove your own login/);
  });

  it("refuses to remove the last owner", () => {
    expect(admin).toMatch(/last owner/i);
    expect(admin).toMatch(/role: \{ gte: 4 \}, active: true/);
  });

  it("only an owner may remove an owner", () => {
    expect(admin).toMatch(/Only the owner can remove an owner/);
  });
});

describe("access ends immediately, not at token expiry", () => {
  it("bumps sessionEpoch so live devices are cut off", () => {
    const fn = admin.slice(admin.indexOf("export async function setStaffActive"));
    expect(fn).toMatch(/sessionEpoch: \{ increment: 1 \}/);
  });

  it("requireStaff rejects an inactive account on every request", () => {
    // the epoch bump alone is not enough: this is the backstop
    expect(read("lib/auth.ts")).toMatch(/if \(!st\.active\) throw new AuthError/);
  });

  it("a removed number cannot even request an OTP", () => {
    const src = read("lib/actions/auth.ts");
    expect(src).toMatch(/if \(!st \|\| !st\.active\) return \{ ok: false as const, error: "This number is not registered as staff" \}/);
    expect(src).toMatch(/if \(!st \|\| !st\.active\) return \{ ok: false as const, error: "Not registered as staff" \}/);
  });

  it("does not reveal that the number was once staff", () => {
    /* An ex-employee probing the login screen should learn nothing, and
       neither should anyone fishing for which numbers are staff. Assert on the
       user-facing ERROR STRINGS only — scanning the whole file would also
       match the comments explaining this, which the student never sees. */
    const src = read("lib/actions/auth.ts");
    const messages = [...src.matchAll(/error:\s*"([^"]+)"/g)].map((m) => m[1]);
    const leaky = messages.filter((m) => /removed|deactivated|disabled|no longer|former/i.test(m));
    expect(leaky).toEqual([]);
    // and the two staff rejections use the same wording as "never registered"
    expect(messages).toContain("This number is not registered as staff");
    expect(messages).toContain("Not registered as staff");
  });
});

describe("the admin screen", () => {
  const ui = read("app/s/admin/_components/AdminClient.tsx");

  it("keeps removed staff visible so the action is reversible", () => {
    expect(ui).toMatch(/Removed/);
    expect(ui).toMatch(/Restore this login/);
  });

  it("confirms before removing", () => {
    expect(ui).toMatch(/confirm\(`Remove \$\{stEdit\.name\}/);
  });

  it("removal is its own action, never a side effect of Save", () => {
    expect(ui).toMatch(/setStaffActive\(stEdit\.id!, false\)/);
    expect(ui).not.toMatch(/saveStaff\([^)]*active/);
  });

  it("passes active through from the server page", () => {
    expect(read("app/s/admin/page.tsx")).toMatch(/active: x\.active/);
  });
});
