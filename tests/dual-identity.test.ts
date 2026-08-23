/* One phone number, two accounts: staff AND student.

   The owner runs the counter and tests the customer app from the same phone.
   Staff and Student are separate tables with separate unique constraints, so
   the schema always allowed this — the seed just never created the student
   row, and signing in on the Customer tab with the documented owner number
   said "not registered". That read as a bug; it was missing data. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const seed = read("prisma/seed.ts");
const auth = read("lib/actions/auth.ts");
const form = read("app/login/_components/LoginForm.tsx");
const schema = read("prisma/schema.prisma");

describe("the schema permits one number in both roles", () => {
  it("phone is unique per TABLE, not across them", () => {
    const staff = schema.slice(schema.indexOf("model Staff"), schema.indexOf("model Subscription"));
    const student = schema.slice(schema.indexOf("model Student"), schema.indexOf("model Staff"));
    expect(staff).toMatch(/phone\s+String\s+@unique/);
    expect(student).toMatch(/phone\s+String\s+@unique/);
    // nothing may forbid the same value appearing in each
    expect(schema).not.toMatch(/@@unique\(\[phone, *role\]\)/);
  });
});

describe("the seed reproduces the dual account", () => {
  it("registers the owner's number as a student too", () => {
    expect(seed).toMatch(/phone: "8019121966", name: "Owner \(customer\)"/);
  });
  it("keeps it as staff as well", () => {
    expect(seed).toMatch(/\{ phone: "8019121966", name: "Owner", role: 4/);
  });
});

describe("signing in stays mode-correct — the part that could have gone wrong", () => {
  it("the STAFF tab never takes the passcode path", () => {
    /* hasPasscode/loginWithPasscode read the STUDENT table and mint a CUSTOMER
       session. With a dual number, routing staff through them would sign the
       owner in as a customer after they pressed Staff. The form must short-
       circuit before that. */
    expect(form).toMatch(/if \(mode === "staff"\) return handleRequestOtp\(\);/);
    const guard = form.indexOf('if (mode === "staff") return handleRequestOtp();');
    const call = form.indexOf("await hasPasscode(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(call);
  });
  it("passcode login can only ever produce a CUSTOMER session", () => {
    const fn = auth.slice(auth.indexOf("export async function loginWithPasscode"));
    expect(fn).toMatch(/createSession\(\{ mode: "customer"/);
    expect(fn).not.toMatch(/mode: "staff"/);
  });
  it("each tab is verified against its OWN table", () => {
    const v = auth.slice(auth.indexOf("export async function verifyOtp"));
    expect(v).toMatch(/if \(mode === "staff"\)[\s\S]{0,200}db\.staff\.findUnique/);
    expect(v).toMatch(/db\.student\.findUnique/);
  });
});

describe("the sign-in screen points a lost staff member at the right tab", () => {
  it("says so unconditionally, so it leaks nothing", () => {
    /* Naming a number as staff only when it IS staff would turn the form into
       a directory of staff numbers — the same leak the staff-tab wording
       already avoids. Shown to everyone, it tells an attacker nothing. */
    expect(form).toMatch(/Staff sign in on the Staff tab above\./);
    expect(form).not.toMatch(/registered as staff/i);
  });
});
