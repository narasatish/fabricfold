/* Guard for the Sep 21 QA finding: the Sheet's Payments log missed plan sales,
   top-ups, refunds, cash compensation and bag fees. Every place that creates a
   Payment row must also queue a Sheet event, or the log stops adding up to the
   Daily/Revenue totals (which count every Payment row). If you add a new
   payment.create, either queue an event beside it or add it here with a reason. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const count = (src: string, re: RegExp) => (src.match(re) || []).length;

/* file -> [payment.create sites, minimum events]. A single event may cover two
   Payment rows written together (an order paid partly by credit, partly cash). */
const EXPECT: Record<string, [number, number]> = {
  "lib/actions/orders.ts": [3, 2],        // pay order (credit+cash rows -> 1 event), refund
  "lib/actions/subscription.ts": [6, 5],  // activate, assign (credit + cash), plan change, cycle pack (credit+cash rows -> 1 event)
  "lib/actions/ops.ts": [1, 1],           // wallet top-up
  "lib/actions/credits.ts": [1, 1],       // cash compensation
  "lib/actions/bags.ts": [1, 1],          // bag fee
};

describe("every Payment row has a Sheet event", () => {
  for (const [file, [creates, minEvents]] of Object.entries(EXPECT)) {
    it(`${file}: ${creates} payment.create site(s), >= ${minEvents} event call(s)`, () => {
      const src = read(file);
      expect(count(src, /payment\.create\(/g), "payment.create count changed — add its Sheet event and update this table").toBe(creates);
      const events = count(src, /enqueuePaymentEvent\(/g) + count(src, /enqueueSheetEvent\(\w+, "payment"/g);
      expect(events).toBeGreaterThanOrEqual(minEvents);
    });
  }
  it("no other action file creates Payment rows unnoticed", () => {
    const dir = path.join(root, "lib/actions");
    const others = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !Object.keys(EXPECT).includes("lib/actions/" + f))
      .filter((f) => /payment\.create\(/.test(fs.readFileSync(path.join(dir, f), "utf8")));
    expect(others).toEqual([]);
  });
});

describe("expenses reach the Sheet too", () => {
  it("submitExpense and payroll-posted expenses queue an Expenses event", () => {
    const src = read("lib/actions/admin.ts");
    expect(count(src, /expense\.create\(/g)).toBe(2);
    expect(count(src, /enqueueExpenseEvent\(/g)).toBe(2);
  });
});
