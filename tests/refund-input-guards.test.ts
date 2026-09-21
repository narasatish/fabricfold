/* refundOrder took `via` and `reason` from the caller unchecked. `via` feeds the
   cash-drawer maths (only "cash" refunds reduce the drawer) and the credit-note
   path, so an arbitrary string is garbage in the ledger; amounts with more than
   2 decimals are not real rupees/paise; reason is unbounded text in the ledger
   note. Found in the Sep 21 testing pass. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const orders = fs.readFileSync(path.resolve(__dirname, "..", "lib/actions/orders.ts"), "utf8");
const i = orders.indexOf("export async function refundOrder");
const body = orders.slice(i, orders.indexOf("\nexport async function ", i + 10));

describe("refundOrder input guards", () => {
  it("only accepts upi, cash or credit as the refund method", () => {
    expect(body).toMatch(/\["upi", "cash", "credit"\]\.includes\(via\)/);
  });
  it("requires a finite amount with at most 2 decimals", () => {
    expect(body).toMatch(/isMoneyAmount\(amount\)/);
  });
  it("caps the reason length", () => {
    expect(body).toMatch(/reason.*\.length > 200|\.slice\(0, 200\)/);
  });
  it("all of it runs before the transaction", () => {
    for (const g of ["includes(via)", "isMoneyAmount(amount)"]) expect(body.indexOf(g)).toBeLessThan(body.indexOf("$transaction"));
  });
});

describe("isMoneyAmount", () => {
  it("accepts real amounts, including ones floating point mangles (1.1, 0.29, 33.33)", async () => {
    const { isMoneyAmount } = await import("../lib/money");
    for (const ok of [1, 1.1, 0.29, 33.33, 118.5, 1180, 4999.99]) expect(isMoneyAmount(ok), String(ok)).toBe(true);
  });
  it("rejects zero, negatives, non-numbers, non-finite and sub-paise values", async () => {
    const { isMoneyAmount } = await import("../lib/money");
    for (const bad of [0, -5, NaN, Infinity, "12" as unknown as number, null, 10.005, 0.001]) expect(isMoneyAmount(bad), String(bad)).toBe(false);
  });
});
