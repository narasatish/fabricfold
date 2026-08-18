/* Removing a campus must not be a one-way door.

   `deleteCollege` sets active:false, which is right — students, orders and
   payments still reference it. But every screen listed only ACTIVE colleges,
   including the admin screen that owns the action, so a removed campus
   vanished from the app and nothing anywhere set the flag back. Its students
   then showed a campus of "-" in lists while their own detail page still
   named it, because that page loads the college directly.

   Found by walking the live app, not by any test. Hence these. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const admin = read("lib/actions/admin.ts");

describe("a removed campus can be brought back", () => {
  it("there is an action that sets active TRUE, not only false", () => {
    expect(admin).toMatch(/export async function setCollegeActive/);
    const fn = admin.slice(admin.indexOf("export async function setCollegeActive"));
    expect(fn).toMatch(/data: \{ active \}/);
  });

  it("removal is still soft — never a hard delete", () => {
    expect(admin).not.toMatch(/college\.delete\(/);
    expect(admin).not.toMatch(/college\.deleteMany\(/);
  });

  it("the last active campus cannot be removed", () => {
    // otherwise there is nowhere to register a student
    expect(admin).toMatch(/Keep at least one campus/);
  });

  it("both directions are audited", () => {
    expect(admin).toMatch(/audit\(active \? "College restored" : "College removed"/);
  });

  it("Owner only", () => {
    const fn = admin.slice(admin.indexOf("export async function setCollegeActive"));
    expect(fn.slice(0, 300)).toMatch(/requireStaff\(4\)/);
  });
});

describe("the admin screen can still see it", () => {
  it("lists ALL colleges, not just active ones", () => {
    // filtering here is what made removal irreversible
    const page = read("app/s/admin/page.tsx");
    expect(page).not.toMatch(/db\.college\.findMany\(\{ where: \{ active: true \}/);
    expect(page).toMatch(/db\.college\.findMany\(\{ orderBy/);
  });

  it("marks a removed campus and offers Restore", () => {
    const ui = read("app/s/admin/_components/AdminClient.tsx");
    expect(ui).toMatch(/Removed/);
    expect(ui).toMatch(/setCollegeActive\(c\.id, true\)/);
  });
});

describe("students keep their campus name", () => {
  it("the students list loads every college, including removed", () => {
    const page = read("app/s/students/page.tsx");
    expect(page).not.toMatch(/db\.college\.findMany\(\{ where: \{ active: true \}/);
  });

  it("labels a removed campus rather than showing a dash", () => {
    const ui = read("app/s/students/_components/StudentsClient.tsx");
    expect(ui).toMatch(/\(removed\)/);
  });
});

describe("the audit log names a person", () => {
  it("resolves the staff id to a name and role", () => {
    /* AuditLog.by is a bare id with no relation, so the screen rendered
       "cmr8n8ffm000fbkbul5y2gbs0". This is the record you reach for after a
       dispute about who cancelled an order. */
    const page = read("app/s/audit/page.tsx");
    expect(page).toMatch(/staffRows\.find/);
    expect(page).toMatch(/nameOf\(l\.by\)/);
  });

  it("falls back rather than hiding an unrecognised actor", () => {
    // config edits applied from the Sheet are recorded as "sheet"
    const page = read("app/s/audit/page.tsx");
    expect(page).toMatch(/Google Sheet edit/);
    expect(page).toMatch(/return by;/);
  });
});
