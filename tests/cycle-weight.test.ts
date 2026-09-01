/* The 5 kg cycle allowance.

   Owner's rule (revised Sep 2026): every plan includes 5 kg per cycle. Under
   it, the cycle pays. Over it, Rs 50 per STARTED kilogram — flat everywhere,
   rounded up, and waivable by staff with the waiver recorded. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { CYCLE_KG_LIMIT, excessWeightCharge, computeBill } from "../lib/money";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const RATE = 15; // legacy 2nd arg — ignored since the flat Rs 50/kg rule

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

describe("under the limit, the cycle pays", () => {
  it.each([0, 1, 3.9, 4.9, 5])("charges nothing at %s kg", (kg) => {
    expect(excessWeightCharge(kg, RATE)).toBe(0);
  });
  it("a cycle order with no excess totals zero", () => {
    expect(computeBill(200, 0, 18, { usedCycle: true, excessCharge: excessWeightCharge(4.4, RATE) }))
      .toEqual({ gst: 0, total: 0 });
  });
});

describe("over the limit, only the excess is charged", () => {
  it("rounds UP to the started HALF kilogram — the owner's own worked example", () => {
    /* 6.5 kg = 1.5 over = Rs 50 + Rs 25 = Rs 75. A scale reading 5.2 then
       5.4 gives the same price; whole-kg rounding would double some bags. */
    expect(excessWeightCharge(6.5, RATE)).toBe(75);
    expect(excessWeightCharge(5.2, RATE)).toBe(25);   // 0.5 started
  });
  // started half-kg over × Rs 25
  it.each([[5.5, 25], [6, 50], [6.1, 75], [8, 150], [10, 250]])("%s kg → ₹%s", (kg, want) => {
    expect(excessWeightCharge(kg, RATE)).toBe(want);
  });
  it("the allowance scales with the cycles used — 9 kg on two cycles is free", () => {
    /* The owner's multi-cycle rule: a student may burn two cycles at once,
       and 2 cycles = 10 kg of allowance. */
    expect(excessWeightCharge(9, RATE, { cycles: 2 })).toBe(0);
    expect(excessWeightCharge(11, RATE, { cycles: 2 })).toBe(50);
    expect(excessWeightCharge(9, RATE, { cycles: 1 })).toBe(200);
  });
  it("a nonsense cycle count falls back to one cycle, never zero", () => {
    expect(excessWeightCharge(6, RATE, { cycles: 0 })).toBe(50);
    expect(excessWeightCharge(6, RATE, { cycles: -2 })).toBe(50);
  });
  it("staff can waive it, and waived means zero at any weight", () => {
    expect(excessWeightCharge(12, RATE, { waived: true })).toBe(0);
  });
  it("the excess is the whole bill on a cycle order — no GST, no piece total", () => {
    const excess = excessWeightCharge(8, RATE);
    expect(computeBill(200, 0, 18, { usedCycle: true, excessCharge: excess }))
      .toEqual({ gst: 0, total: 150 });
  });
  it("still adds the urgent premium when both apply", () => {
    expect(computeBill(200, 59, 18, { usedCycle: true, excessCharge: excessWeightCharge(8, RATE) }).total)
      .toBe(150 + 59);
  });
});

describe("it can't go negative or NaN", () => {
  it.each([null, undefined, NaN, -3])("handles %s", (kg) => {
    expect(excessWeightCharge(kg as number, RATE)).toBe(0);
  });
  it("a missing legacy rate arg changes nothing — the flat rate ignores it", () => {
    expect(excessWeightCharge(11, undefined as unknown as number)).toBe(300);
  });
});

describe("the counter can see it before committing", () => {
  const ui = read("app/s/orders/[id]/_components/OrderClient.tsx");
  it("quotes the charge with the SAME function that bills it", () => {
    // a hand-rolled preview is how the quoted number drifts from the charged one
    expect(ui).toMatch(/import \{ CYCLE_KG_LIMIT, CYCLE_RATES, isCycleService, excessWeightCharge \} from "@\/lib\/money"/);
    expect(ui).toMatch(/excessWeightCharge\(acceptInput\.weightKg, undefined, \{ waived: acceptInput\.waiveExcess, cycles: cycleBased \? acceptInput\.cycles : 1 \}\)/);
  });
  it("says plainly when the bag is within the cycle", () => {
    expect(ui).toMatch(/Within the \{allowanceKg\} kg allowance/); // allowance scales with cycles now
  });
  it("names the amount to collect when it is over", () => {
    expect(ui).toMatch(/over the \{allowanceKg\} kg allowance — collect \{fmt\(excessNow\)\}/);
    // and it quotes started HALF kilograms, matching what bills
    expect(ui).toMatch(/Math\.ceil\(overKg \* 2\) \/ 2/);
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
       while cycle orders came to zero; with a 7 kg allowance, a heavy bag owes
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

describe("a subscriber's order uses their plan by default", () => {
  const ui = read("app/s/orders/[id]/_components/OrderClient.tsx");
  it("defaults the cycle toggle ON when a plan has cycles left", () => {
    /* It defaulted to false, so every cycle order depended on the counter
       remembering to flick a toggle. Forget it and the student is billed the
       full per-piece price despite holding a plan — and no weight allowance is
       applied, because that only runs on cycle orders. */
    expect(ui).toMatch(/const canUseCycle = !!order\.student\.subscription\?\.active && subCyclesLeft > 0;/);
    expect(ui).toMatch(/useCycle: canUseCycle,/);
    expect(ui).not.toMatch(/useCycle: false,/);
  });
  it("stays off for a student with no plan, or none left", () => {
    // subCyclesLeft is 0 without a subscription, so canUseCycle is false
    expect(ui).toMatch(/const subCyclesLeft = order\.student\.subscription/);
    expect(ui).toMatch(/cyclesTotal - order\.student\.subscription\.cyclesUsed/);
    expect(ui).toMatch(/: 0;/);
  });
  it("staff can still turn it off", () => {
    expect(ui).toMatch(/onToggle=\{\(\) => setAcceptInput\(\{ \.\.\.acceptInput, useCycle: !acceptInput\.useCycle \}\)\}/);
  });
});
