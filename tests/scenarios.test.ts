/* Real-life scenario tests.

   These walk the situations that actually happen at a counter and assert the
   money and cycle invariants that must never break. They test the SHARED pure
   logic the server actions use (computeBill, urgentCycleCharge, bag codes),
   which is where a wrong number would silently cost real money — the actions
   themselves need a staff session and are covered at the source level and by
   scripts/e2e-check.ts against a live database. */
import { describe, expect, it } from "vitest";
import { computeBill, urgentCycleCharge, expressSurcharge, EXPRESS_PCT, shouldInvoiceOrder } from "../lib/money";
import { formatBagCode, parseBagCode, bagKindFor, MAX_PER_KIND } from "../lib/bagcode";
import { MIN_DAMAGE_PHOTOS, cleanPhotos } from "../lib/complaint-rules";

/* St Mary's, as actually configured: every tier is 34 cycles, price is final. */
const BRONZE = 4000, SILVER = 5000, GOLD = 6000, CYCLES = 34;

describe("scenario: subscribed student, ordinary wash on a plan cycle", () => {
  it("costs the student nothing and raises no GST", () => {
    const { gst, total } = computeBill(180, 0, 18, { usedCycle: true });
    expect(total).toBe(0);
    expect(gst).toBe(0);
  });

  it("is auto-marked paid, because a zero balance has nothing to collect", () => {
    const { total } = computeBill(180, 0, 18, { usedCycle: true });
    // mirrors acceptOrder: paid = usedCycle && total === 0
    expect(total === 0).toBe(true);
  });
});

describe("scenario: subscribed student wants it same-day (the urgent rule)", () => {
  it("charges 40% of the plan's per-cycle value, in cash", () => {
    // Silver: 5000/34 = 147.06/cycle, 40% = 58.8 -> 59
    expect(urgentCycleCharge(SILVER, CYCLES)).toBe(59);
    expect(urgentCycleCharge(BRONZE, CYCLES)).toBe(47);
    expect(urgentCycleCharge(GOLD, CYCLES)).toBe(71);
  });

  it("does NOT re-charge the cycle itself — only the premium is owed", () => {
    const urgent = urgentCycleCharge(SILVER, CYCLES);
    const { total, gst } = computeBill(180, urgent, 18, { usedCycle: true });
    expect(total).toBe(59); // not 147+59, and not the 180 of item value
    expect(gst).toBe(0);
  });

  it("leaves a balance owing, so the order must NOT auto-mark paid", () => {
    const urgent = urgentCycleCharge(SILVER, CYCLES);
    const { total } = computeBill(180, urgent, 18, { usedCycle: true });
    expect(total === 0).toBe(false);
    // collectOrder blocks while `!paid && total > 0`
    expect(!false && total > 0).toBe(true);
  });

  it("regression: a cycle order's surcharge is never silently dropped", () => {
    // This was a real bug — the usedCycle branch ignored `surcharge` entirely,
    // so marking a cycle order express collected nothing at all.
    expect(computeBill(0, 59, 18, { usedCycle: true }).total).toBe(59);
  });
});

describe("scenario: subscribed student brings an overweight bag", () => {
  it("pays only the excess, with no GST on a cycle order", () => {
    const { total, gst } = computeBill(200, 0, 18, { usedCycle: true, excessCharge: 45 });
    expect(total).toBe(45);
    expect(gst).toBe(0);
  });

  it("pays excess AND the urgent premium when both apply", () => {
    const urgent = urgentCycleCharge(SILVER, CYCLES);
    expect(computeBill(200, urgent, 18, { usedCycle: true, excessCharge: 45 }).total).toBe(45 + 59);
  });
});

describe("scenario: walk-in with no subscription", () => {
  it("pays item value plus GST", () => {
    expect(computeBill(500, 0, 18)).toEqual({ gst: 90, total: 590 });
  });

  it("same-day adds 40% of the ORDER value, not a plan value", () => {
    expect(expressSurcharge(500)).toBe(200);
    const { total } = computeBill(500, expressSurcharge(500), 18);
    expect(total).toBe(700 + 126);
  });

  it("staff may bill without GST, and that order is never invoiced", () => {
    expect(computeBill(500, 0, 18, { noGst: true })).toEqual({ gst: 0, total: 500 });
    expect(shouldInvoiceOrder({ noGst: true }, "upi")).toBe(false);
    expect(shouldInvoiceOrder({ noGst: false }, "upi")).toBe(true);
  });

  it("cash is only invoiced when staff explicitly override", () => {
    expect(shouldInvoiceOrder({ noGst: false }, "cash")).toBe(false);
    expect(shouldInvoiceOrder({ noGst: false }, "cash", true)).toBe(true);
  });
});

describe("scenario: bags handed over at the counter", () => {
  it("gives each tier its own letter, and non-subscribers a separate series", () => {
    expect(formatBagCode(bagKindFor("bronze"), 1)).toBe("B001");
    expect(formatBagCode(bagKindFor("silver"), 1)).toBe("S001");
    expect(formatBagCode(bagKindFor("gold"), 1)).toBe("G001");
    expect(formatBagCode(bagKindFor(null), 1)).toBe("W001");
  });

  it("keeps tier series independent — B001 and G001 coexist", () => {
    expect(formatBagCode("bronze", 1)).not.toBe(formatBagCode("gold", 1));
  });

  it("a code read off a bag maps back to exactly one student's tier", () => {
    expect(parseBagCode("G014")).toEqual({ kind: "gold", n: 14 });
    expect(parseBagCode("W001")).toEqual({ kind: "walkin", n: 1 });
  });

  it("refuses to mint a code past the printable range instead of wrapping", () => {
    expect(formatBagCode("bronze", MAX_PER_KIND)).toBe("B999");
    expect(formatBagCode("bronze", MAX_PER_KIND + 1)).toBeNull();
  });

  it("a smudged or mistyped code is rejected, never guessed", () => {
    for (const bad of ["BOO1", "B 01", "b1", "G1000", "Z001"]) {
      expect(parseBagCode(bad), bad).toBeNull();
    }
  });
});

describe("scenario: staff reports damage before washing", () => {
  it("needs at least three photos", () => {
    expect(cleanPhotos(["a", "b"]).length).toBeLessThan(MIN_DAMAGE_PHOTOS);
    expect(cleanPhotos(["a", "b", "c"]).length).toBeGreaterThanOrEqual(MIN_DAMAGE_PHOTOS);
  });

  it("blank entries don't count toward the minimum", () => {
    // Three "photos" that are really empty strings must not satisfy the rule.
    expect(cleanPhotos(["a", "", "  ", "b"])).toEqual(["a", "b"]);
    expect(cleanPhotos(["", "", ""]).length).toBe(0);
  });

  it("accepts more than the minimum", () => {
    expect(cleanPhotos(Array.from({ length: 12 }, (_, i) => `p${i}`)).length).toBe(12);
  });
});

describe("money invariants that must hold for every plan", () => {
  it("the urgent premium is always exactly 40% of a cycle, rounded", () => {
    for (const price of [BRONZE, SILVER, GOLD, 7000, 12345]) {
      expect(urgentCycleCharge(price, CYCLES)).toBe(Math.round((price / CYCLES) * EXPRESS_PCT));
    }
  });

  it("never divides by zero on a malformed plan", () => {
    expect(urgentCycleCharge(SILVER, 0)).toBe(0);
  });

  it("a richer plan never makes urgent cheaper", () => {
    expect(urgentCycleCharge(BRONZE, CYCLES)).toBeLessThan(urgentCycleCharge(GOLD, CYCLES));
  });

  it("no billing path can produce a negative total", () => {
    for (const sub of [0, 100, 999]) {
      for (const sur of [0, 59, 200]) {
        expect(computeBill(sub, sur, 18).total).toBeGreaterThanOrEqual(0);
        expect(computeBill(sub, sur, 18, { usedCycle: true }).total).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
