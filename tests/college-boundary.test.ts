/* Campus isolation, at the SERVER — not just hidden in the UI.

   Found by a security audit (Sep 2026), after the owner said "students,
   staff should not mixup, never": a Staff row scoped to one campus
   (collegeId set) had that data available on every request but nothing
   ever checked it. Any staff action taking a studentId/orderId/bagId/
   planId/complaintId/staffId trusted it blindly — a St Mary's-scoped
   Manager could call refundOrder() or cancelOrder() on a BVRIT order id
   directly and it would just work, UI or no UI.

   assertSameCollege() closes that gap. This file locks two things: the
   helper's own behaviour, and that every call site the audit found
   actually calls it. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { assertSameCollege, AuthError } from "../lib/auth";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");

describe("assertSameCollege", () => {
  it("lets a campus-scoped staff member through for their OWN campus", () => {
    expect(() => assertSameCollege({ collegeId: "stmarys" }, "stmarys")).not.toThrow();
  });
  it("refuses a campus-scoped staff member touching a DIFFERENT campus", () => {
    expect(() => assertSameCollege({ collegeId: "stmarys" }, "bvrit")).toThrow(AuthError);
  });
  it("refuses reaching a target with no campus at all (null) from a scoped account", () => {
    expect(() => assertSameCollege({ collegeId: "stmarys" }, null)).toThrow(AuthError);
  });
  it("a GLOBAL staff member (collegeId null — Owner/Admin) passes for every campus", () => {
    expect(() => assertSameCollege({ collegeId: null }, "stmarys")).not.toThrow();
    expect(() => assertSameCollege({ collegeId: null }, "bvrit")).not.toThrow();
    expect(() => assertSameCollege({ collegeId: null }, null)).not.toThrow();
  });
});

describe("the boundary is actually enforced at every server action the audit found", () => {
  const orders = read("lib/actions/orders.ts");
  const bags = read("lib/actions/bags.ts");
  const credits = read("lib/actions/credits.ts");
  const complaints = read("lib/actions/complaints.ts");
  const students = read("lib/actions/students.ts");
  const admin = read("lib/actions/admin.ts");
  const subscription = read("lib/actions/subscription.ts");
  const auth = read("lib/auth.ts");

  it("assertSameCollege is exported from lib/auth.ts and reads the STAFF row's collegeId, not the token", () => {
    expect(auth).toMatch(/export function assertSameCollege/);
  });

  it("orders.ts: every staff mutation on an existing order checks it", () => {
    const fns = ["acceptOrder", "advanceStatus", "collectOrder", "recordPay", "refundOrder", "redoOrder", "cancelOrder", "scanTag", "walkInOrder"];
    for (const fn of fns) {
      const body = orders.slice(orders.indexOf(`export async function ${fn}`), orders.indexOf(`export async function ${fn}`) + 1500);
      expect(body, fn).toMatch(/assertSameCollege\(st,/);
    }
  });

  it("bags.ts: every bag mutation checks the bag's OWN student's campus", () => {
    const fns = ["issueBag", "syncBagToPlan", "reissueBagSameCode", "setBagCode", "releaseBagCode", "retireBag"];
    for (const fn of fns) {
      const body = bags.slice(bags.indexOf(`export async function ${fn}`), bags.indexOf(`export async function ${fn}`) + 1200);
      expect(body, fn).toMatch(/assertSameCollege\(st,/);
    }
  });

  it("credits.ts: compensation checks the target student's campus", () => {
    expect(credits).toMatch(/assertSameCollege\(st, stu\.collegeId\)/);
  });

  it("complaints.ts: staff replies, damage reports, free re-service and resolution all check it", () => {
    const fns = ["sendComplaintMessage", "reportOrderDamage", "grantFreeReservice", "resolveComplaint"];
    for (const fn of fns) {
      const body = complaints.slice(complaints.indexOf(`export async function ${fn}`), complaints.indexOf(`export async function ${fn}`) + 1500);
      expect(body, fn).toMatch(/assertSameCollege\(st,/);
    }
  });

  it("students.ts: search is filtered by the caller's campus, not just found ids", () => {
    // The worse half of the original bug: a scoped staff member could
    // actively ENUMERATE another campus's students by name/phone/code.
    expect(students).toMatch(/const where = st\.collegeId \? \{ AND: \[\{ OR: or \}, \{ collegeId: st\.collegeId \}\] \} : \{ OR: or \}/);
    expect(students).toMatch(/assertSameCollege\(st, collegeId\)/); // bulkRegisterStudents
    expect(students).toMatch(/You can only notify your own campus/); // broadcastNotice
  });

  it("admin.ts: registration, phone/detail edits, plans, rates, features and staff management all check it", () => {
    const fns = ["registerStudent", "updateStudentPhone", "updateStudentDetails", "savePlan", "togglePlan", "saveCollegeRates", "toggleFeature", "saveStaff", "setStaffActive", "createPayslip"];
    for (const fn of fns) {
      const body = admin.slice(admin.indexOf(`export async function ${fn}`), admin.indexOf(`export async function ${fn}`) + 1800);
      expect(body, fn).toMatch(/assertSameCollege\(st,/);
    }
  });

  it("subscription.ts: every plan/cycle action on a student checks it", () => {
    const fns = ["adjustCycleUsage", "activateSubscription", "assignSubscription", "upgradeSubscription", "cancelSubscription", "sellCyclePack"];
    for (const fn of fns) {
      const body = subscription.slice(subscription.indexOf(`export async function ${fn}`), subscription.indexOf(`export async function ${fn}`) + 1500);
      expect(body, fn).toMatch(/assertSameCollege\(st,/);
    }
  });

  it("complaint photos are scoped to the viewing staff member's campus, not open to any staff", () => {
    const route = read("app/api/complaint-photo/route.ts");
    expect(route).not.toMatch(/if \(s\.mode === "staff"\) return true;/);
    expect(route).toMatch(/if \(!st\.collegeId\) return true;/);
  });
});
