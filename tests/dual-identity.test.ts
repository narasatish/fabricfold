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
  it("the STAFF view never renders a passcode path at all (Sep 2026 redesign)", () => {
    /* hasPasscode/loginWithPasscode read the STUDENT table and mint a CUSTOMER
       session. The old guard was a runtime short-circuit before that call;
       the redesign removes the possibility structurally — the phone field
       and handleContinue (which calls hasPasscode) render ONLY inside the
       `mode === "customer"` branch, so a dual-identity owner on the Staff
       view has no phone field to type into and no path to hasPasscode. */
    // isolate the staff branch by its own marker comment through to where
    // the ternary closes, rather than fragile paren-counting past the
    // customer branch's OWN nested ternary (showPhone ? ... : ...)
    const staffBranch = form.slice(form.indexOf("Staff: WhatsApp only"), form.indexOf("{/* A QR scan"));
    expect(staffBranch).not.toMatch(/hasPasscode|handleContinue/);
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

describe("the sign-in screen points a lost staff member at the right door", () => {
  it("the corner link is always there (Sep 2026: a link, not a tab), and never leaks who is staff", () => {
    /* Naming a number as staff only when it IS staff would turn the form into
       a directory of staff numbers. The corner link is unconditional — shown
       to every visitor regardless of their number — so it tells an attacker
       nothing, same guarantee as the old tab wording. */
    expect(form).toMatch(/Staff sign-in/);
    expect(form).not.toMatch(/registered as staff/i);
  });
});
