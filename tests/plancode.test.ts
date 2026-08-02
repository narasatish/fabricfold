/* Bag codes are printed on physical bags — a duplicate or a mis-parsed code
   means two students holding the same label, so the format rules are pinned
   down here. Allocation itself is transactional (FySequence) and covered by
   the same guarantees as invoice numbering. */
import { describe, expect, it } from "vitest";
import { formatPlanCode, parsePlanCode, MAX_PER_TIER, TIER_LETTER } from "../lib/plancode";

describe("bag code formatting", () => {
  it("zero-pads to three digits behind the tier letter", () => {
    expect(formatPlanCode("bronze", 1)).toBe("B001");
    expect(formatPlanCode("silver", 1)).toBe("S001");
    expect(formatPlanCode("gold", 1)).toBe("G001");
    expect(formatPlanCode("bronze", 42)).toBe("B042");
    expect(formatPlanCode("gold", 999)).toBe("G999");
  });

  it("refuses anything outside 1..999 rather than emitting a wrong label", () => {
    expect(formatPlanCode("bronze", 0)).toBeNull();
    expect(formatPlanCode("bronze", -1)).toBeNull();
    expect(formatPlanCode("bronze", MAX_PER_TIER + 1)).toBeNull();
    expect(formatPlanCode("bronze", 1.5)).toBeNull();
  });

  it("round-trips through parsePlanCode", () => {
    for (const tier of ["bronze", "silver", "gold"] as const) {
      for (const n of [1, 7, 250, 999]) {
        const code = formatPlanCode(tier, n)!;
        expect(parsePlanCode(code)).toEqual({ tier, n });
      }
    }
  });

  it("parses case-insensitively and tolerates surrounding whitespace", () => {
    expect(parsePlanCode(" b042 ")).toEqual({ tier: "bronze", n: 42 });
  });

  it("rejects malformed codes", () => {
    for (const bad of ["", "B", "B1", "B01", "B0001", "X001", "B000", "BB01", "001", "B-01"]) {
      expect(parsePlanCode(bad), bad).toBeNull();
    }
  });

  it("uses one distinct letter per tier", () => {
    const letters = Object.values(TIER_LETTER);
    expect(new Set(letters).size).toBe(letters.length);
  });
});
