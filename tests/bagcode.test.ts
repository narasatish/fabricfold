/* Bag codes are printed on physical bags — a duplicate or a mis-parsed code
   means two students holding the same label, so the format rules are pinned
   down here. Allocation itself is transactional (FySequence), the same
   guarantee invoice numbering relies on. */
import { describe, expect, it } from "vitest";
import { formatBagCode, parseBagCode, bagKindFor, MAX_PER_KIND, BAG_LETTER } from "../lib/bagcode";

describe("bag code formatting", () => {
  it("zero-pads to three digits behind the kind letter", () => {
    expect(formatBagCode("bronze", 1)).toBe("B001");
    expect(formatBagCode("silver", 1)).toBe("S001");
    expect(formatBagCode("gold", 1)).toBe("G001");
    expect(formatBagCode("walkin", 1)).toBe("W001");
    expect(formatBagCode("bronze", 42)).toBe("B042");
    expect(formatBagCode("gold", 999)).toBe("G999");
  });

  it("refuses anything outside 1..999 rather than emitting a wrong label", () => {
    expect(formatBagCode("bronze", 0)).toBeNull();
    expect(formatBagCode("bronze", -1)).toBeNull();
    expect(formatBagCode("bronze", MAX_PER_KIND + 1)).toBeNull();
    expect(formatBagCode("bronze", 1.5)).toBeNull();
  });

  it("round-trips through parseBagCode", () => {
    for (const kind of ["bronze", "silver", "gold", "walkin"] as const) {
      for (const n of [1, 7, 250, 999]) {
        expect(parseBagCode(formatBagCode(kind, n)!)).toEqual({ kind, n });
      }
    }
  });

  it("parses case-insensitively and tolerates surrounding whitespace", () => {
    expect(parseBagCode(" b042 ")).toEqual({ kind: "bronze", n: 42 });
  });

  it("rejects malformed codes", () => {
    for (const bad of ["", "B", "B1", "B01", "B0001", "X001", "B000", "BB01", "001", "B-01"]) {
      expect(parseBagCode(bad), bad).toBeNull();
    }
  });

  it("uses one distinct letter per kind", () => {
    const letters = Object.values(BAG_LETTER);
    expect(new Set(letters).size).toBe(letters.length);
  });

  it("maps a missing or unknown tier to the walk-in kind", () => {
    expect(bagKindFor("gold")).toBe("gold");
    expect(bagKindFor(null)).toBe("walkin");
    expect(bagKindFor(undefined)).toBe("walkin");
    expect(bagKindFor("platinum")).toBe("walkin");
  });
});
