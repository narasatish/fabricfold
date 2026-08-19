/* The customer ID follows the plan.

   The code on the bag IS the student's customer ID — B### Bronze, S###
   Silver, G### Gold. Assigning a plan and issuing the bag were two unrelated
   manual steps, so a Silver subscriber could sit with no S-code at all,
   showing only the internal 6-digit reference. Found by looking at a real
   student card, not by any test. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { BAG_LETTER, bagKindFor } from "../lib/bagcode";
import { loyaltyBadge } from "../lib/format";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const subs = read("lib/actions/subscription.ts");
const bags = read("lib/actions/bags.ts");

describe("every path that turns a plan on allocates the code", () => {
  it.each(["assignSubscription", "activateSubscription", "upgradeSubscription"])(
    "%s calls syncBagToPlan",
    (fn) => {
      const start = subs.indexOf(`export async function ${fn}`);
      expect(start, `${fn} not found`).toBeGreaterThan(-1);
      const rest = subs.slice(start + 1);
      const end = rest.indexOf("\nexport async function ");
      const body = end === -1 ? rest : rest.slice(0, end);
      expect(body, `${fn} does not allocate a customer ID`).toMatch(/syncBagToPlan\(studentId\)/);
    },
  );

  it("allocates AFTER the payment, never inside it", () => {
    // a paid subscription must not roll back because a code could not be got
    const start = subs.indexOf("export async function assignSubscription");
    const body = subs.slice(start);
    expect(body.indexOf("db.$transaction")).toBeLessThan(body.indexOf("syncBagToPlan"));
  });
});

describe("syncBagToPlan", () => {
  it("is idempotent — a correct bag is left alone", () => {
    expect(bags).toMatch(/if \(active && bagKindFor\(active\.tier\) === wanted\)/);
    expect(bags).toMatch(/changed: false/);
  });

  it("retires the old code before issuing the new letter", () => {
    // issueBag refuses while an active bag exists
    expect(bags).toMatch(/status: "replaced", note: `Plan changed/);
  });

  it("never throws, so it cannot undo a paid subscription", () => {
    const fn = bags.slice(bags.indexOf("export async function syncBagToPlan"));
    expect(fn).toMatch(/catch \(e\)/);
    expect(fn).toMatch(/console\.error\("\[bags\] syncBagToPlan failed:/);
  });
});

describe("the letter matches the tier", () => {
  it("maps each tier to its prefix", () => {
    expect(BAG_LETTER[bagKindFor("bronze")]).toBe("B");
    expect(BAG_LETTER[bagKindFor("silver")]).toBe("S");
    expect(BAG_LETTER[bagKindFor("gold")]).toBe("G");
    expect(BAG_LETTER[bagKindFor(null)]).toBe("W");
  });
});

describe("loyalty no longer collides with plan tiers", () => {
  it("does not reuse Bronze/Silver/Gold", () => {
    /* A "Bronze" loyalty pill sat next to a Silver plan on the same card,
       which reads as a data error and cannot be interpreted at a counter. */
    const names = [loyaltyBadge(0).name, loyaltyBadge(60).name, loyaltyBadge(200).name];
    for (const n of names) expect(["Bronze", "Silver", "Gold"]).not.toContain(n);
    expect(new Set(names).size).toBe(3); // still three distinct steps
  });
});

describe("a lost bag keeps the student's number", () => {
  it("reissues the SAME code rather than allocating a new one", () => {
    /* The code is the student's identity. Changing it because they mislaid a
       bag would make "permanent customer ID" untrue. */
    expect(bags).toMatch(/export async function reissueBagSameCode/);
    const fn = bags.slice(bags.indexOf("export async function reissueBagSameCode"));
    expect(fn).toMatch(/code: bag\.code, \/\/ the whole point: same number, new bag/);
    expect(fn).not.toMatch(/allocateBagCode/);
  });

  it("retires the old row inside the same transaction", () => {
    // one ACTIVE bag per code, so the old must stop being active first
    const fn = bags.slice(bags.indexOf("export async function reissueBagSameCode"));
    expect(fn).toMatch(/db\.\$transaction/);
    expect(fn).toMatch(/status: "lost"/);
  });

  it("is free — losing a bag is not billed here", () => {
    const fn = bags.slice(bags.indexOf("export async function reissueBagSameCode"));
    expect(fn).toMatch(/complimentary: true/);
    expect(fn).toMatch(/price: 0/);
  });

  it("warns staff to destroy the old bag if it turns up", () => {
    const ui = read("app/s/customers/[id]/_components/CustomerClient.tsx");
    expect(ui).toMatch(/Destroy it; do not put it back into stock/);
  });
});
