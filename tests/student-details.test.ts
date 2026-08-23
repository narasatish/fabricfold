/* Editing a student's details.

   Name, campus and wash day had no edit path at all — only phone did. Campus
   is the one that is not a plain field: a plan belongs to a campus, so moving
   a subscribed student would leave them holding something their new campus
   does not sell. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const admin = read("lib/actions/admin.ts");
const fn = admin.slice(admin.indexOf("export async function updateStudentDetails"));
const ui = read("app/s/customers/[id]/_components/CustomerClient.tsx");

describe("permission", () => {
  it("is Admin+", () => {
    expect(fn.slice(0, 300)).toMatch(/requireStaff\(3\)/);
  });
  it("leaves the phone to its own action", () => {
    // changing the number changes who can log in; it deserves its own step
    expect(fn).not.toMatch(/data\.phone/);
    expect(admin).toMatch(/export async function updateStudentPhone/);
  });
  it("records what actually changed, not just that something did", () => {
    expect(fn).toMatch(/audit\("Student updated"/);
    expect(fn).toMatch(/changes\.join\("; "\)/);
  });
});

describe("moving campus is guarded", () => {
  it("refuses while they hold an active plan", () => {
    expect(fn).toMatch(/holds an active \$\{stu\.subscription\.plan\}/);
  });
  it("refuses while orders are still open there", () => {
    expect(fn).toMatch(/still open at their current campus/);
  });
  it("refuses a removed campus, pointing at the fix", () => {
    expect(fn).toMatch(/has been removed — restore it first/);
  });
  it("does NOT rewrite past orders", () => {
    /* Orders record where the work was done. Rewriting them would misstate
       every per-campus statement already issued. */
    expect(fn).not.toMatch(/order\.updateMany/);
  });
  it("reassigns the wash day on the new campus rota", () => {
    // a day balanced against the old campus means nothing at the new one
    expect(fn).toMatch(/data\.washDay = null/);
    expect(fn).toMatch(/if \(data\.collegeId\) await assignWashDay/);
  });
});

describe("wash day", () => {
  it("rejects a day outside the week", () => {
    expect(fn).toMatch(/wd < 0 \|\| wd > 6/);
  });
  it("rejects the campus's closed day", () => {
    expect(fn).toMatch(/That is the campus's closed day/);
  });
});

describe("no-op safety", () => {
  it("returns early when nothing actually differs", () => {
    // avoids an audit entry and a realtime ping for opening and closing a form
    expect(fn).toMatch(/if \(!changes\.length\) return \{ ok: true as const, changed: false \}/);
  });
});

describe("the staff card exposes it", () => {
  it("has an edit control, Admin+ only", () => {
    expect(ui).toMatch(/setShowDetails\(true\)/);
    expect(ui).toMatch(/staffRole >= 3 && \(/);
  });
  it("warns about the plan BEFORE they press save", () => {
    // the refusal is a rule about plans, not a validation slip
    expect(ui).toMatch(/Their plan belongs to the current campus/);
  });
  it("greys out the closed day rather than letting them pick it", () => {
    expect(ui).toMatch(/campus closed/);
    expect(ui).toMatch(/disabled=\{closed\}/);
  });
});

describe("realtime", () => {
  it("tells BOTH campuses about a move", () => {
    // the receiving counter's list is wrong until it hears about the arrival
    expect(fn).toMatch(/if \(data\.collegeId\) channels\.push\(`orders:\$\{data\.collegeId\}`\)/);
  });
});
