/* Order intake takes numbers typed at the counter. Found in the Sep 21 testing
   pass: acceptOrder did not cap item quantity (walkInOrder caps it at 99), so a
   mistyped 5000 became a ₹75,000 bill and Infinity crashed the write; and
   neither action validated weightKg (NaN / negative / absurd stored as-is). */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const orders = fs.readFileSync(path.resolve(__dirname, "..", "lib/actions/orders.ts"), "utf8");
const fnBody = (name: string) => {
  const i = orders.indexOf(`export async function ${name}`);
  return orders.slice(i, orders.indexOf("\nexport async function ", i + 10));
};

describe("acceptOrder / walkInOrder input guards", () => {
  it("acceptOrder caps a typed quantity at 99, same as walkInOrder", () => {
    expect(fnBody("acceptOrder")).toMatch(/qty: Math\.min\(99, Math\.floor\(i\.qty\)\)/);
    expect(fnBody("walkInOrder")).toMatch(/qty: Math\.min\(99, Math\.floor\(i\.qty\)\)/);
  });
  for (const fn of ["acceptOrder", "walkInOrder"]) {
    it(`${fn} rejects an invalid weight before touching the database`, () => {
      const body = fnBody(fn);
      expect(body).toMatch(/validWeight\(input\.weightKg\)/);
      expect(body.indexOf("validWeight(")).toBeLessThan(body.indexOf("$transaction"));
    });
  }
  it("validWeight: null is fine; NaN, negative and absurd values are not", async () => {
    const { validWeight } = await import("../lib/money");
    expect(validWeight(null)).toBe(true);
    expect(validWeight(4.5)).toBe(true);
    expect(validWeight(0)).toBe(true);
    for (const bad of [NaN, Infinity, -1, 501, "5" as unknown as number]) expect(validWeight(bad)).toBe(false);
  });
});
