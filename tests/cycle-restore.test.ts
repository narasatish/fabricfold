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

/** Slice out one function's source — works for exported actions and for
    module-local helpers like restoreCycleFor. */
function body(fnName: string) {
  const decl = [`export async function ${fnName}`, `async function ${fnName}`]
    .map((d) => src.indexOf(d))
    .filter((i) => i > -1)
    .sort((a, b) => a - b)[0];
  expect(decl, `${fnName} not found`).toBeGreaterThan(-1);

  const rest = src.slice(decl + 1);
  const ends = ["\nexport async function ", "\nasync function "]
    .map((m) => rest.indexOf(m))
    .filter((i) => i > -1);
  const next = ends.length ? Math.min(...ends) : -1;
  return next === -1 ? src.slice(decl) : src.slice(decl, decl + 1 + next);
}

describe("cancelling an order returns the cycle", () => {
  const restore = body("restoreCycleFor");
  const cancel = body("cancelOrder");

  it("cancel always restores — the wash never happened", () => {
    expect(cancel).toMatch(/restoreCycleFor\(/);
  });

  it("only restores when a cycle was actually used", () => {
    expect(restore).toMatch(/ord\.usedCycle/);
  });

  it("decrements the subscription's used-cycle count", () => {
    expect(restore).toMatch(/cyclesUsed\s*[:=]\s*\{\s*decrement:\s*1\s*\}/);
  });

  it("never drives cyclesUsed below zero", () => {
    expect(restore).toMatch(/sub\.cyclesUsed\s*>\s*0/);
  });

  it("gives the cycle back to the bucket for THAT service, not just the total", () => {
    expect(restore).toMatch(/b\.service === ord\.service/);
    expect(restore).toMatch(/used:\s*buckets\[idx\]\.used\s*-\s*1/);
  });

  it("removes the cycle-use log row so history matches the balance", () => {
    expect(restore).toMatch(/cycleUse\.deleteMany/);
  });

  it("clears usedCycle, so the order no longer claims to hold one", () => {
    expect(restore).toMatch(/usedCycle:\s*false/);
  });

  it("runs inside the caller's transaction — a half-restore is worse than none", () => {
    expect(restore).toMatch(/tx:\s*Prisma\.TransactionClient/);
    expect(cancel).toMatch(/db\.\$transaction/);
  });

  it("refuses to cancel twice, which would refund the cycle twice", () => {
    expect(cancel).toMatch(/already cancelled/i);
  });

  it("refuses to cancel an order that was already collected", () => {
    expect(cancel).toMatch(/already been collected/i);
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
    // Any change of code letter is a free swap — walk-in to a tier, or Bronze
    // to Gold. The label has to follow the plan, and billing for that would be
    // charging a student for upgrading.
    expect(bags).toMatch(/upgradingFromWalkIn/);
    expect(bags).toMatch(/lastKind !== kind/);
  });

  it("a priced bag posts a counter payment so it hits the day's cash", () => {
    expect(bags).toMatch(/tx\.payment\.create/);
  });

  it("retiring a bag never reissues its code", () => {
    expect(bags).toMatch(/status !== "active"/);
  });
});

describe("expiry: unused cycles are forfeited, never carried over", () => {
  const src2 = fs.readFileSync(path.resolve(__dirname, "../lib/actions/orders.ts"), "utf8");

  it("a plan past its expiry date cannot spend a cycle", () => {
    expect(src2).toMatch(/function subscriptionBlocker/);
    expect(src2).toMatch(/sub\.expiresAt\.getTime\(\) < Date\.now\(\)/);
  });

  it("both the pre-booked and walk-in paths enforce it", () => {
    const hits = src2.match(/subscriptionBlocker\(/g) || [];
    // one definition + one call in acceptOrder + one in walkInOrder
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  it("tells the student cycles are forfeited rather than failing vaguely", () => {
    expect(src2).toMatch(/forfeited/i);
  });
});

describe("refund does not silently hand back a cycle", () => {
  const src3 = fs.readFileSync(path.resolve(__dirname, "../lib/actions/orders.ts"), "utf8");

  it("restoring on refund is opt-in, defaulting to off", () => {
    // refunding only an urgent premium still means the wash happened
    expect(src3).toMatch(/restoreCycle\s*=\s*false/);
  });

  it("cancel and refund share one restore implementation", () => {
    const calls = src3.match(/restoreCycleFor\(/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(3); // definition + cancel + refund
  });
});

describe("bag codes warn before they run out", () => {
  const bc = fs.readFileSync(path.resolve(__dirname, "../lib/bagcode.ts"), "utf8");
  const ba = fs.readFileSync(path.resolve(__dirname, "../lib/actions/bags.ts"), "utf8");

  it("warns with lead time, since bags are printed in advance", () => {
    expect(bc).toMatch(/WARN_AT\s*=\s*900/);
    expect(ba).toMatch(/seq >= WARN_AT/);
    expect(ba).toMatch(/notifyOwner/);
  });
});

describe("recount before marking ready", () => {
  const adv = body("advanceStatus");

  it("compares the recount against what was logged at intake", () => {
    expect(adv).toMatch(/intakeCount/);
    expect(adv).toMatch(/o\.actualPieces \?\? o\.declaredPieces/);
  });

  it("a shortfall can never be negative", () => {
    expect(adv).toMatch(/Math\.max\(0, intakeCount - n\)/);
  });

  it("tells the student BEFORE they open the bag, not at the counter", () => {
    expect(adv).toMatch(/shortBy > 0/);
    expect(adv).toMatch(/pushNotif/);
    expect(adv).toMatch(/notifyOwner/);
  });

  it("records the discrepancy in the audit log", () => {
    expect(adv).toMatch(/Piece shortfall at ready/);
  });

  it("skips reconciliation entirely when no count is supplied", () => {
    expect(adv).toMatch(/counted !== null && counted !== undefined/);
  });
});

describe("changing plan mid-term", () => {
  const sub = fs.readFileSync(path.resolve(__dirname, "../lib/actions/subscription.ts"), "utf8");

  it("charges only the difference in price", () => {
    expect(sub).toMatch(/const difference = newGross - oldGross/);
  });

  it("refuses a downgrade rather than automating a refund", () => {
    expect(sub).toMatch(/difference <= 0/);
  });

  it("keeps cycles already used — a plan change is not a free reset", () => {
    expect(sub).toMatch(/usedByService/);
    expect(sub).toMatch(/used: Math\.min\(b\.cycles, usedByService\.get\(b\.service\) \|\| 0\)/);
  });

  it("refuses to 'upgrade' an expired plan", () => {
    expect(sub).toMatch(/cur\.expiresAt\.getTime\(\) < Date\.now\(\)/);
  });

  it("requires Manager+ because money changes hands", () => {
    const fn = sub.slice(sub.indexOf("export async function upgradeSubscription"));
    expect(fn).toMatch(/requireStaff\(2\)/);
  });
});

describe("loopholes closed around walk-ins and plan changes", () => {
  const bags = fs.readFileSync(path.resolve(__dirname, "../lib/actions/bags.ts"), "utf8");
  const sub = fs.readFileSync(path.resolve(__dirname, "../lib/actions/subscription.ts"), "utf8");

  it("a walk-in with no plan does NOT get a free bag", () => {
    // the free bag is a subscription perk; otherwise anyone collects one
    // without ever buying a plan
    expect(bags).toMatch(/const subscribed = !!stu\.subscription\?\.active/);
    expect(bags).toMatch(/subscribed && !hasHadFreeBag/);
  });

  it("the free bag can only ever be claimed once", () => {
    expect(bags).toMatch(/hasHadFreeBag = stu\.bags\.some\(\(b\) => b\.complimentary\)/);
  });

  it("compares against the MOST RECENT bag, not an arbitrary row", () => {
    expect(bags).toMatch(/bags: \{ orderBy: \{ issuedAt: "desc" \} \}/);
  });

  it("a legacy plan with no buckets can't be upgraded into a free cycle reset", () => {
    expect(sub).toMatch(/!oldBuckets\.length && cur\.cyclesUsed > 0/);
    expect(sub).toMatch(/toSpend -= take/);
  });
});
