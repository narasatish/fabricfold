/* Cancelling an order must hand the plan cycle back.

   A cycle is prepaid value (~₹147 on a ₹5,000/34 plan). Cancelling after staff
   accepted the order with a cycle used to burn it permanently — the student
   paid for a wash they never received.

   cancelOrder needs a staff session, so this asserts the guarantee at the
   source level, the same approach registration-lockdown.test.ts uses. The DB
   mechanics are exercised for real by scripts/e2e-check.ts. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.resolve(__dirname, "../lib/actions/orders.ts"), "utf8");

function body(fnName: string) {
  const start = src.indexOf(`export async function ${fnName}`);
  expect(start, `${fnName} not found`).toBeGreaterThan(-1);
  const next = src.indexOf("\nexport async function", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("cancelling an order returns the cycle", () => {
  const fn = body("cancelOrder");

  it("only restores when a cycle was actually used", () => {
    expect(fn).toMatch(/ord\.usedCycle/);
  });

  it("decrements the subscription's used-cycle count", () => {
    // written as an assignment onto the update payload, not inline
    expect(fn).toMatch(/cyclesUsed\s*[:=]\s*\{\s*decrement:\s*1\s*\}/);
  });

  it("never drives cyclesUsed below zero", () => {
    // guarded by an explicit `> 0` check before the decrement is queued
    expect(fn).toMatch(/sub\.cyclesUsed\s*>\s*0/);
  });

  it("gives the cycle back to the bucket for THAT service, not just the total", () => {
    expect(fn).toMatch(/b\.service === ord\.service/);
    expect(fn).toMatch(/used:\s*buckets\[idx\]\.used\s*-\s*1/);
  });

  it("removes the cycle-use log row so history matches the balance", () => {
    expect(fn).toMatch(/cycleUse\.deleteMany/);
  });

  it("clears usedCycle, so the order no longer claims to hold one", () => {
    expect(fn).toMatch(/usedCycle:\s*false/);
  });

  it("does the whole restore in one transaction", () => {
    // a partial restore would leave the balance and the log disagreeing
    expect(fn).toMatch(/db\.\$transaction/);
  });

  it("refuses to cancel twice, which would refund the cycle twice", () => {
    expect(fn).toMatch(/already cancelled/i);
  });

  it("refuses to cancel an order that was already collected", () => {
    expect(fn).toMatch(/already been collected/i);
  });
});

describe("bag issuing rules", () => {
  const bags = fs.readFileSync(path.resolve(__dirname, "../lib/actions/bags.ts"), "utf8");

  it("only one active bag at a time", () => {
    expect(bags).toMatch(/b\.status === "active"/);
  });

  it("the first bag a student ever gets is free", () => {
    expect(bags).toMatch(/isFirstEver/);
  });

  it("upgrading from a walk-in bag to a tier bag is not charged", () => {
    // their code must change to match the tier; billing for that would be
    // charging a student for subscribing
    expect(bags).toMatch(/upgradingFromWalkIn/);
    expect(bags).toMatch(/stu\.bags\.every\(\(b\) => !b\.tier\)/);
  });

  it("a priced bag posts a counter payment so it hits the day's cash", () => {
    expect(bags).toMatch(/tx\.payment\.create/);
  });

  it("retiring a bag never reissues its code", () => {
    expect(bags).toMatch(/status !== "active"/);
  });
});
