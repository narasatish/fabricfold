/* Cancelling a plan ends something the student paid for, so the guarantees
   around it are asserted rather than assumed.

   cancelSubscription needs a staff session, so this checks the rules at the
   source level — the same approach registration-lockdown.test.ts uses. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.resolve(__dirname, "../lib/actions/subscription.ts"), "utf8");

function body(fnName: string) {
  const start = src.indexOf(`export async function ${fnName}`);
  expect(start, `${fnName} not found`).toBeGreaterThan(-1);
  const next = src.indexOf("\nexport async function", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("admin cancels a plan", () => {
  const fn = body("cancelSubscription");

  it("is Admin+ only — it ends something the student paid for", () => {
    expect(fn).toMatch(/requireStaff\(3\)/);
  });

  it("demands a reason rather than accepting a blank one", () => {
    expect(fn).toMatch(/note\.length < 3/);
  });

  it("records who cancelled, when, and why", () => {
    expect(fn).toMatch(/cancelledAt:\s*new Date\(\)/);
    expect(fn).toMatch(/cancelledReason:\s*note/);
    expect(fn).toMatch(/cancelledBy:\s*st\.id/);
  });

  it("keeps the subscription row — history hangs off it", () => {
    // deleting it would orphan cycle history and the audit trail
    expect(fn).not.toMatch(/subscription\.delete/);
    expect(fn).toMatch(/active:\s*false/);
  });

  it("refuses to cancel a plan that is already inactive", () => {
    expect(fn).toMatch(/already inactive/i);
  });

  it("moves no money on its own", () => {
    // a cancellation that silently refunded would be a payment nobody authorised
    expect(fn).not.toMatch(/payment\.create/);
    expect(fn).not.toMatch(/createCreditNote/);
  });

  it("tells the student, and says how many cycles were lost", () => {
    expect(fn).toMatch(/pushNotif/);
    expect(fn).toMatch(/cyclesTotal - sub\.cyclesUsed/);
  });

  it("is audited and reported to the Owner", () => {
    expect(fn).toMatch(/audit\("Subscription cancelled"/);
    expect(fn).toMatch(/notifyOwner/);
  });
});
