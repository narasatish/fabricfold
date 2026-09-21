/* Found in the Sep 21 QA pass: the customer statement and the college statement
   built "this month" with new Date(y, m-1, 1) - the SERVER's clock (UTC on Render),
   not IST - so an order at 00:30 IST on the 1st landed in the previous month's
   statement; and a malformed ?m= crashed the route. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { istMonthRange } from "../lib/report";

describe("istMonthRange", () => {
  it("a month starts and ends at IST midnight (18:30 UTC the day before)", () => {
    const r = istMonthRange("2026-10")!;
    expect(r.from.toISOString()).toBe("2026-09-30T18:30:00.000Z");
    expect(r.to.toISOString()).toBe("2026-10-31T18:30:00.000Z");
  });
  it("an order at 00:30 IST on 1 October belongs to October, not September", () => {
    const at = new Date("2026-09-30T19:00:00.000Z"); // 00:30 IST 1 Oct
    const oct = istMonthRange("2026-10")!, sep = istMonthRange("2026-09")!;
    expect(at >= oct.from && at < oct.to).toBe(true);
    expect(at >= sep.from && at < sep.to).toBe(false);
  });
  it("December rolls into January", () => {
    const r = istMonthRange("2026-12")!;
    expect(r.to.toISOString()).toBe("2026-12-31T18:30:00.000Z");
  });
  it("rejects anything that isn't YYYY-MM", () => {
    for (const bad of ["", "abc", "2026-13", "2026-00", "2026-1", "26-10", "2026/10", "2026-10-01", null, undefined]) {
      expect(istMonthRange(bad as never), String(bad)).toBeNull();
    }
  });
});

describe("both statement routes use it and refuse a bad month", () => {
  for (const f of ["app/api/export/statement/route.ts", "app/api/export/college-statement/route.ts"]) {
    it(f, () => {
      const src = fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");
      expect(src).toMatch(/istMonthRange\(/);
      expect(src).not.toMatch(/new Date\(y, mo/);
      expect(src).toMatch(/status: 400/);
    });
  }
});
