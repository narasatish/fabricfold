/* flagOutlierStaff (lib/report.ts) — owner request 2026-10-22: highlight a
   staff member whose refund/cancel/comp activity stands out from the team,
   instead of requiring the owner to do that comparison by eye every time.
   Deliberately simple (>= 2x team average AND >= 3 actions), not a
   statistical model — these tests lock that exact threshold behavior. */
import { describe, expect, it } from "vitest";
import { flagOutlierStaff, OUTLIER_MULTIPLIER } from "../lib/report";

describe("flagOutlierStaff", () => {
  it("flags nobody when the team is empty", () => {
    expect(flagOutlierStaff([])).toEqual(new Set());
  });

  it("flags nobody when everyone does roughly the same amount", () => {
    const rows = [
      { staffId: "a", refunds: 2, cancels: 1, comps: 0 },
      { staffId: "b", refunds: 1, cancels: 2, comps: 0 },
      { staffId: "c", refunds: 2, cancels: 0, comps: 1 },
    ];
    expect(flagOutlierStaff(rows)).toEqual(new Set());
  });

  it("flags a staff member at or above 2x the team average, if also past the minimum", () => {
    // avg = (1 + 1 + 8) / 3 = 3.33; 8 >= 3.33*2 (6.67) and 8 >= MIN_ACTIONS
    const rows = [
      { staffId: "a", refunds: 1, cancels: 0, comps: 0 },
      { staffId: "b", refunds: 0, cancels: 1, comps: 0 },
      { staffId: "c", refunds: 5, cancels: 2, comps: 1 },
    ];
    expect(flagOutlierStaff(rows)).toEqual(new Set(["c"]));
  });

  it("does NOT flag a high multiple when the absolute count is still below the floor", () => {
    // avg = (0 + 0 + 2) / 3 = 0.67; 2 >= 0.67*2 (1.33) but 2 < OUTLIER_MIN_ACTIONS (3)
    const rows = [
      { staffId: "a", refunds: 0, cancels: 0, comps: 0 },
      { staffId: "b", refunds: 0, cancels: 0, comps: 0 },
      { staffId: "c", refunds: 1, cancels: 1, comps: 0 },
    ];
    expect(flagOutlierStaff(rows)).toEqual(new Set());
  });

  it("can flag more than one staff member independently", () => {
    // avg = (0 + 0 + 10 + 10) / 4 = 5; 10 >= 5*2 exactly for both c and d
    const rows = [
      { staffId: "a", refunds: 0, cancels: 0, comps: 0 },
      { staffId: "b", refunds: 0, cancels: 0, comps: 0 },
      { staffId: "c", refunds: 10, cancels: 0, comps: 0 },
      { staffId: "d", refunds: 0, cancels: 10, comps: 0 },
    ];
    expect(flagOutlierStaff(rows)).toEqual(new Set(["c", "d"]));
  });

  it(`uses exactly ${OUTLIER_MULTIPLIER}x as the boundary (right at the line counts as flagged)`, () => {
    // avg = (0 + 0 + 6) / 3 = 2; 6 >= 2*2 exactly
    const rows = [
      { staffId: "a", refunds: 0, cancels: 0, comps: 0 },
      { staffId: "b", refunds: 0, cancels: 0, comps: 0 },
      { staffId: "c", refunds: 3, cancels: 3, comps: 0 },
    ];
    expect(flagOutlierStaff(rows)).toEqual(new Set(["c"]));
  });
});
