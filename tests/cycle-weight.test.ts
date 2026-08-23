/* The 5 kg cycle allowance.

   Owner's rule: every plan includes 5 kg per cycle. Under it, the cycle pays.
   Over it, the student pays for the weight that is actually over — and the
   counter shows a UPI QR for that amount. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { CYCLE_KG_LIMIT, excessWeightCharge, computeBill } from "../lib/money";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const RATE = 15; // base garment rate in the seeded config → ₹45/kg over

describe("the allowance is the same for every tier", () => {
  it("is 5 kg", () => {
    expect(CYCLE_KG_LIMIT).toBe(5);
  });
  it("billing no longer reads the per-plan or per-bucket kgPerCycle", () => {
    /* Those columns hold 7 on seeded plans. Reading them meant two students on
       the same plan could get different allowances. They stay in the schema so
       past orders still explain themselves; they must not drive new bills. */
    const orders = read("lib/actions/orders.ts");
    expect(orders).not.toMatch(/kgLimit/);
    expect(orders).not.toMatch(/Number\(sub\.kgPerCycle\)/);
    expect(orders).toMatch(/excessWeightCharge\(input\.weightKg, cfg\.rates\.washIron\.items\[0\]\[1\]\)/);
  });
  it("applies at BOTH billing sites, not just the counter", () => {
    const orders = read("lib/actions/orders.ts");
    expect(orders.match(/excessWeightCharge\(/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("under the limit, the cycle pays", () => {
  it.each([0, 1, 4.9, 5])("charges nothing at %s kg", (kg) => {
    expect(excessWeightCharge(kg, RATE)).toBe(0);
  });
  it("a cycle order with no excess totals zero", () => {
    expect(computeBill(200, 0, 18, { usedCycle: true, excessCharge: excessWeightCharge(4.2, RATE) }))
      .toEqual({ gst: 0, total: 0 });
  });
});

describe("over the limit, only the excess is charged", () => {
  it("bills the weight actually over, not a rounded-up kilo", () => {
    // 5.2 kg → 0.2 kg over → ₹9, NOT ₹45. The old Math.ceil billed a whole
    // extra kilo for 200 g, which is the charge students argue about.
    expect(excessWeightCharge(5.2, RATE)).toBe(9);
  });
  // 1 kg over = ₹45 (15 x 3); 2.5 over = ₹112.5 -> ₹113; 5 over = ₹225
  it.each([[6, 45], [7.5, 113], [10, 225]])("%s kg → ₹%s", (kg, want) => {
    expect(excessWeightCharge(kg, RATE)).toBe(want);
  });
  it("the excess is the whole bill on a cycle order — no GST, no piece total", () => {
    const excess = excessWeightCharge(6, RATE);
    expect(computeBill(200, 0, 18, { usedCycle: true, excessCharge: excess }))
      .toEqual({ gst: 0, total: 45 });
  });
  it("still adds the urgent premium when both apply", () => {
    expect(computeBill(200, 59, 18, { usedCycle: true, excessCharge: excessWeightCharge(6, RATE) }).total)
      .toBe(45 + 59);
  });
});

describe("it can't go negative or NaN", () => {
  it.each([null, undefined, NaN, -3])("handles %s", (kg) => {
    expect(excessWeightCharge(kg as number, RATE)).toBe(0);
  });
  it("a missing rate charges nothing rather than NaN", () => {
    expect(excessWeightCharge(9, undefined as unknown as number)).toBe(0);
  });
});

describe("the counter can see it before committing", () => {
  const ui = read("app/s/orders/[id]/_components/OrderClient.tsx");
  it("quotes the charge with the SAME function that bills it", () => {
    // a hand-rolled preview is how the quoted number drifts from the charged one
    expect(ui).toMatch(/import \{ CYCLE_KG_LIMIT, excessWeightCharge \} from "@\/lib\/money"/);
    expect(ui).toMatch(/excessWeightCharge\(acceptInput\.weightKg, baseGarmentRate\)/);
  });
  it("says plainly when the bag is within the cycle", () => {
    expect(ui).toMatch(/Within the \{CYCLE_KG_LIMIT\} kg cycle/);
  });
  it("names the amount to collect when it is over", () => {
    expect(ui).toMatch(/over the \{CYCLE_KG_LIMIT\} kg cycle — collect \{fmt\(excessNow\)\}/);
  });
});

describe("the weight field is typed, not clicked", () => {
  const ui = read("app/s/orders/[id]/_components/OrderClient.tsx");
  it("has no number spinner", () => {
    const field = ui.slice(ui.indexOf("<label>Weight (kg)</label>"), ui.indexOf("<label>Weight (kg)</label>") + 1400);
    expect(field).toMatch(/type="text"/);
    expect(field).not.toMatch(/type="number"/);
    expect(field).not.toMatch(/step=/);
  });
  it("still raises a numeric keypad on a phone", () => {
    expect(ui).toMatch(/inputMode="decimal"/);
  });
  it("keeps the raw string while typing, so '5.' does not fight the typist", () => {
    expect(ui).toMatch(/const \[weightText, setWeightText\]/);
  });
});

describe("the excess can actually be collected", () => {
  const ui = read("app/s/orders/[id]/_components/OrderClient.tsx");
  it("offers payment whenever money is owed, whatever billed it", () => {
    /* This gate used to read `!order.usedCycle`, which hid the payment button
       — and with it the ONLY route to the UPI QR — on every cycle order. Fine
       while cycle orders came to zero; with a 5 kg allowance, a heavy bag owes
       real money that could not be taken in the app. */
    expect(ui).toMatch(/\{!order\.paid && Number\(order\.total\) > 0 && \(/);
    expect(ui).not.toMatch(/!order\.paid && !order\.usedCycle/);
  });
  it("names the amount and the reason on the button", () => {
    expect(ui).toMatch(/Collect \$\{fmt\(Number\(order\.total\)\)\} — over the \$\{CYCLE_KG_LIMIT\} kg cycle/);
  });
  it("still hides it when the cycle covered everything", () => {
    // total is 0 on an in-allowance cycle order, so the gate closes on its own
    expect(computeBill(200, 0, 18, { usedCycle: true, excessCharge: 0 }).total).toBe(0);
  });
  it("the QR carries the order total, so it matches what is owed", () => {
    expect(ui).toMatch(/upiLink\(upi\.upiId, upi\.payeeName, remaining,/);
  });
});
