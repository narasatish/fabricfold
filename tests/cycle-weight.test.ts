/* The 5 kg cycle allowance.

   Management decision (revised Sep 2026): weight over the 5 kg allowance is
   NEVER billed. Staff or the student decide — burn another cycle to cover a
   heavier bag, or take the extra back. excessWeightCharge always returns 0
   now; it is kept (not deleted) so every call site keeps compiling. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { CYCLE_KG_LIMIT, excessWeightCharge, computeBill } from "../lib/money";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");

describe("the allowance is the same for every tier", () => {
  it("is 5 kg", () => {
    expect(CYCLE_KG_LIMIT).toBe(5);
  });
  it("billing no longer reads the per-plan or per-bucket kgPerCycle", () => {
    /* Reading those columns meant two students on the same plan could get
       different allowances, and nothing stopped a stray value being saved.
       They stay in the schema so past orders still explain themselves; they
       must not drive new bills. */
    const orders = read("lib/actions/orders.ts");
    expect(orders).not.toMatch(/kgLimit/);
    expect(orders).not.toMatch(/Number\(sub\.kgPerCycle\)/);
    expect(orders).toMatch(/excessWeightCharge\(input\.weightKg, undefined, \{ waived: !!input\.waiveExcess, cycles: cyclesCount \}\)/);
  });
  it("applies at BOTH billing sites, not just the counter", () => {
    const orders = read("lib/actions/orders.ts");
    expect(orders.match(/excessWeightCharge\(/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("weight over the allowance is never billed", () => {
  it.each([0, 1, 3.9, 4.9, 5, 5.2, 6, 6.5, 8, 9, 10, 12])("charges nothing at %s kg", (kg) => {
    expect(excessWeightCharge(kg)).toBe(0);
  });
  it("still zero regardless of cycles, waived flag, or a legacy rate arg", () => {
    expect(excessWeightCharge(11, 15, { cycles: 2 })).toBe(0);
    expect(excessWeightCharge(11, 15, { cycles: 1 })).toBe(0);
    expect(excessWeightCharge(11, 15, { waived: true })).toBe(0);
    expect(excessWeightCharge(11, undefined)).toBe(0);
  });
  it("a cycle order over the allowance still totals zero (before any express premium)", () => {
    expect(computeBill(200, 0, 18, { usedCycle: true, excessCharge: excessWeightCharge(9) }))
      .toEqual({ gst: 0, total: 0 });
  });
  it("an express premium on an over-allowance cycle order still applies — only the weight is free", () => {
    expect(computeBill(200, 59, 18, { usedCycle: true, excessCharge: excessWeightCharge(9) }).total)
      .toBe(59);
  });
});

describe("it can't go negative or NaN — always zero either way", () => {
  it.each([null, undefined, NaN, -3])("handles %s", (kg) => {
    expect(excessWeightCharge(kg as number)).toBe(0);
  });
});

describe("the counter reflects the no-charge policy", () => {
  const ui = read("app/s/orders/[id]/_components/OrderClient.tsx");
  it("no longer imports or quotes excessWeightCharge — there is nothing to quote", () => {
    expect(ui).not.toMatch(/excessWeightCharge/);
  });
  it("says plainly when the bag is within the cycle", () => {
    expect(ui).toMatch(/Within the \{allowanceKg\} kg allowance/); // allowance scales with cycles now
  });
  it("tells staff over-allowance weight is free — add a cycle or send it back", () => {
    expect(ui).toMatch(/kg over the \{allowanceKg\} kg allowance — no charge; add another cycle above to cover it, or send the excess back with the student\./);
  });
  it("dropped the now-pointless waive-charge toggle", () => {
    expect(ui).not.toMatch(/Waive excess charge/);
    expect(ui).not.toMatch(/waiveExcess/);
  });
});

describe("the weight field is typed, not clicked", () => {
  const ui = read("app/s/orders/[id]/_components/OrderClient.tsx");
  it("has no number spinner", () => {
    const field = ui.slice(ui.indexOf("<label>Weight (kg)"), ui.indexOf("<label>Weight (kg)") + 1400);
    expect(field).toMatch(/type="text"/);
    expect(field).not.toMatch(/type="number"/);
    expect(field).not.toMatch(/step=/);
  });
  it("still raises a numeric keypad on a phone", () => {
    expect(ui).toMatch(/inputMode="decimal"/);
  });
  it("is mandatory before Accept — no weight, no cycle count to bill by (owner, Sep 22)", () => {
    expect(ui).toMatch(/cycleBased && !acceptInput\.weightKg/);
    expect(ui).toMatch(/Enter the weight \(kg\) before accepting this order/);
  });
  it("keeps the raw string while typing, so '5.' does not fight the typist", () => {
    expect(ui).toMatch(/const \[weightText, setWeightText\]/);
  });
});
