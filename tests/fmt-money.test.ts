/* Found in the Sep 21 QA pass: the refund confirmation read "Refund ₹1.1 via CASH?".
   Money shows whole rupees, or exactly two decimals - never ₹1.1 or ₹1,234.567. */
import { describe, expect, it } from "vitest";
import { fmt } from "../lib/format";

describe("fmt", () => {
  it("whole rupees stay whole", () => {
    expect(fmt(270)).toBe("₹270");
    expect(fmt(0)).toBe("₹0");
    expect(fmt(1234567)).toBe("₹12,34,567"); // Indian grouping, as before
    expect(fmt("500")).toBe("₹500");
  });
  it("fractional amounts always show two decimals", () => {
    expect(fmt(1.1)).toBe("₹1.10");
    expect(fmt(118.5)).toBe("₹118.50");
    expect(fmt(99.99)).toBe("₹99.99");
    expect(fmt(1234.567)).toBe("₹1,234.57");
  });
  it("copes with junk instead of printing NaN", () => {
    expect(fmt(null)).toBe("₹0");
    expect(fmt(undefined)).toBe("₹0");
    expect(fmt(NaN)).toBe("₹0");
  });
});
