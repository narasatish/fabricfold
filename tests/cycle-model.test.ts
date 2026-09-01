/* The cycle-basis model (owner, Sep 2026).

   Wash services are sold by the CYCLE — Rs 200 Wash & Fold, Rs 250 Wash &
   Iron, each carrying 5 kg — and the rate is FINAL: no GST, ever, on a cycle
   order. Excess weight is Rs 25 per started half-kg (the owner's own 6.5 kg
   → Rs 75 example) and applies to plan-paid and cash-paid orders alike.
   Faculty buy flexible packs of cycles rather than tiered plans.

   Thought through as the owner asked — as a student, as counter staff, as a
   teacher — and each seat's failure mode is pinned below. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { CYCLE_RATES, isCycleService, excessWeightCharge, computeBill, CYCLE_KG_LIMIT } from "../lib/money";
import { parseBagCode, formatBagCode, BAG_LETTER } from "../lib/bagcode";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const orders = read("lib/actions/orders.ts");
const subs = read("lib/actions/subscription.ts");

describe("the rates", () => {
  it("Rs 200 Wash & Fold, Rs 250 Wash & Iron — and nothing else is a cycle service", () => {
    expect(CYCLE_RATES.washFold).toBe(200);
    expect(CYCLE_RATES.washIron).toBe(250);
    expect(isCycleService("washFold")).toBe(true);
    expect(isCycleService("washIron")).toBe(true);
    expect(isCycleService("dryClean")).toBe(false);  // a saree is not a weight class
    expect(isCycleService("ironOnly")).toBe(false);  // owner: keep per-piece
  });
});

describe("as a student — every billing scenario", () => {
  it("scenario: 4 kg on a plan cycle → nothing to pay", () => {
    const excess = excessWeightCharge(4, undefined, { cycles: 1 });
    expect(computeBill(200, 0, 18, { usedCycle: true, excessCharge: excess })).toEqual({ gst: 0, total: 0 });
  });
  it("scenario: 6.5 kg on a plan cycle → Rs 75, the owner's example", () => {
    const excess = excessWeightCharge(6.5, undefined, { cycles: 1 });
    expect(computeBill(200, 0, 18, { usedCycle: true, excessCharge: excess })).toEqual({ gst: 0, total: 75 });
  });
  it("scenario: 9 kg burning TWO cycles → nothing (10 kg allowance)", () => {
    const excess = excessWeightCharge(9, undefined, { cycles: 2 });
    expect(computeBill(400, 0, 18, { usedCycle: true, excessCharge: excess })).toEqual({ gst: 0, total: 0 });
  });
  it("scenario: 9 kg insisting on ONE cycle → Rs 200 excess; their wish, priced", () => {
    expect(excessWeightCharge(9, undefined, { cycles: 1 })).toBe(200);
  });
  it("scenario: no plan, 6 kg Wash & Fold, one cycle → 200 + 50 = 250, GST-free", () => {
    /* The FINAL-price rule: Rs 200 means Rs 200. noGst is forced for cycle
       services, and the excess rides outside the taxable base. */
    const excess = excessWeightCharge(6, undefined, { cycles: 1 });
    expect(computeBill(200, 0, 18, { usedCycle: false, excessCharge: excess, noGst: true })).toEqual({ gst: 0, total: 250 });
  });
  it("scenario: no plan, 9 kg Wash & Iron on two cycles → flat 500", () => {
    const excess = excessWeightCharge(9, undefined, { cycles: 2 });
    expect(computeBill(2 * 250, 0, 18, { usedCycle: false, excessCharge: excess, noGst: true })).toEqual({ gst: 0, total: 500 });
  });
});

describe("as counter staff", () => {
  it("the 500-600 g grace is the waive toggle, not a hidden threshold", () => {
    // 5.5 kg is Rs 25 by the book; the STAFF decide to let it go, and the
    // decision is recorded — a silent free band would be invisible forever
    expect(excessWeightCharge(5.5, undefined, { cycles: 1 })).toBe(25);
    expect(excessWeightCharge(5.5, undefined, { cycles: 1, waived: true })).toBe(0);
    expect(orders).toMatch(/audit\("Excess weight waived"/);
  });
  it("cycle orders always price the excess — plan-paid or cash-paid alike", () => {
    // the excess computation sits OUTSIDE the useCycle branch now
    const accept = orders.slice(orders.indexOf("export async function acceptOrder("));
    const excessAt = accept.indexOf("excessCharge = excessWeightCharge");
    const useCycleAt = accept.indexOf("if (input.useCycle)");
    expect(excessAt).toBeGreaterThan(-1);
    expect(excessAt).toBeLessThan(useCycleAt);
  });
  it("burning N cycles requires N to actually be there", () => {
    expect(orders).toMatch(/b\.used \+ cyclesCount <= b\.cycles/);
    expect(orders).toMatch(/Not enough .* cycles left on this plan \(needs \$\{cyclesCount\}\)/);
  });
  it("one CycleUse row per cycle, so cancelling restores exactly what was burned", () => {
    expect(orders).toMatch(/createMany\(\{ data: Array\.from\(\{ length: cyclesCount \}/);
    expect(orders).toMatch(/const n = Math\.max\(1, Math\.floor\(ord\.cyclesCount \?\? 1\)\)/);
  });
  it("a restore can never drive a balance negative", () => {
    expect(orders).toMatch(/Math\.min\(n, sub\.cyclesUsed\)/);
    expect(orders).toMatch(/Math\.max\(0, buckets\[idx\]\.used - n\)/);
  });
  it("GST is forced OFF for cycle services at every entry point", () => {
    // acceptOrder + walkInOrder both carry the same clause
    expect(orders.match(/isCycleService\((o|input)\.service\) \|\| !!input\.noGst/g)?.length).toBe(2);
    // and the pre-booked draft is stamped noGst at creation
    expect(orders).toMatch(/noGst: isCycleService\(input\.service\)/);
  });
  it("the synthetic cycle line keeps qty = cycles, as the owner asked pieces to become", () => {
    expect(orders).toMatch(/rate: CYCLE_RATES\[service\], qty: n/);
  });
});

describe("as faculty", () => {
  it("the pack: cycles × rate, Manager+ takes the money", () => {
    const fn = subs.slice(subs.indexOf("export async function sellCyclePack"));
    expect(fn).toMatch(/requireStaff\(2\)/);
    expect(fn).toMatch(/const price = cycles \* rate/);
  });
  it("no GST invoice — the payment is recorded, the Sheet hears about it", () => {
    const fn = subs.slice(subs.indexOf("export async function sellCyclePack"));
    expect(fn).not.toMatch(/createInvoice/);
    expect(fn).toMatch(/tx\.payment\.create/);
    expect(fn).toMatch(/enqueueSheetEvent\(tx, "payment"/);
  });
  it("a top-up ADDS to unused cycles — discarding them would be theft by bookkeeping", () => {
    const fn = subs.slice(subs.indexOf("export async function sellCyclePack"));
    expect(fn).toMatch(/cycles: buckets\[idx\]\.cycles \+ cycles/);
  });
  it("students cannot be sold packs — they buy plans", () => {
    expect(subs).toMatch(/Cycle packs are for faculty — students buy plans/);
  });
  it("faculty carry the F series whatever they have bought", () => {
    expect(BAG_LETTER.faculty).toBe("F");
    expect(parseBagCode("F1001")).toEqual({ kind: "faculty", n: 1001 });
    expect(formatBagCode("faculty", 1001)).toBe("F1001");
    expect(read("lib/actions/bags.ts")).toMatch(/stu\.kind === "faculty" \? \("faculty" as const\)/);
  });
  it("the import registers F rows as faculty and invents no subscription", () => {
    const imp = read("app/api/import/students/route.ts");
    expect(imp).toMatch(/const isFaculty = parsed\.kind === "faculty"/);
    expect(imp).toMatch(/kind: isFaculty \? "faculty" : "student"/);
    // subscription creation is guarded on a plan existing, and faculty have none
    expect(imp).toMatch(/if \(plan\) \{\s*\n\s*const buckets = usageBuckets/);
  });
  it("registration at the counter can mark faculty, and it is audited as such", () => {
    const admin = read("lib/actions/admin.ts");
    expect(admin).toMatch(/kind\?: "student" \| "faculty"/);
    expect(admin).toMatch(/"Faculty registered" : "Student registered"/);
  });
});

describe("the screens quote what the server bills", () => {
  it("customer order form: cycle stepper, final price, no GST line", () => {
    const ui = read("app/c/order/new/_components/OrderNewClient.tsx");
    expect(ui).toMatch(/const gst = cycleBased \? 0 :/);
    expect(ui).toMatch(/cycles: cycleBased \? cycles : undefined/);
    expect(ui).toMatch(/per cycle · up to \{CYCLE_KG_LIMIT \* cycles\} kg total/);
  });
  it("staff accept sheet scales the allowance with the cycle count", () => {
    const ui = read("app/s/orders/[id]/_components/OrderClient.tsx");
    expect(ui).toMatch(/const allowanceKg = CYCLE_KG_LIMIT \* \(cycleBased \? acceptInput\.cycles : 1\)/);
    expect(ui).toMatch(/cycles: cycleBased \? acceptInput\.cycles : 1/);
  });
  it("walk-in: cycle stepper for cycle services, item grid for the rest", () => {
    const ui = read("app/s/customers/[id]/_components/CustomerClient.tsx");
    expect(ui).toMatch(/isCycleService\(wiService\) \? \(/);
    expect(ui).toMatch(/cycles: isCycleService\(wiService\) \? wiCycles : undefined/);
  });
  it("the GST toggle disappears where GST can never apply", () => {
    expect(read("app/s/orders/[id]/_components/OrderClient.tsx")).toMatch(/\{!acceptInput\.useCycle && !cycleBased && \(/);
    expect(read("app/s/customers/[id]/_components/CustomerClient.tsx")).toMatch(/!wiUseCycle && gstEnabled && !isCycleService\(wiService\) && \(/);
  });
  it("the pack card exists, faculty-only, Manager+, with the 6-months example", () => {
    const ui = read("app/s/customers/[id]/_components/CustomerClient.tsx");
    expect(ui).toMatch(/student\.kind === "faculty" && staffRole >= 2 && \(/);
    expect(ui).toMatch(/6 months × 4\/month = 24 cycles/);
  });
});

describe("the dry-clean menu", () => {
  it("is the owner's five items in the seed", () => {
    const seed = read("prisma/seed.ts");
    for (const [item, price] of [["Kurta", 100], ["Saree", 200], ["Single blanket", 200], ["Double blanket", 250]] as const) {
      expect(seed).toContain(`["${item}", ${price}]`);
    }
    expect(seed).toContain('["Shirt / T-shirt / Pant", 80]');
  });
  it("and the admin can now change the MENU, not just the prices", () => {
    const ui = read("app/s/admin/_components/AdminClient.tsx");
    expect(ui).toMatch(/addRateItem/);
    expect(ui).toMatch(/removeRateItem/);
  });
});

describe("switching the service tab shows THAT service's menu", () => {
  /* Found live: the page passed only the FIRST service's item list, so a
     student on the Dry Clean tab was quoted Wash & Iron's names and prices.
     A menu that lies about prices is the bug a laundry can least afford. */
  it("the page hands over the whole rates map", () => {
    expect(read("app/c/order/new/page.tsx")).toMatch(/allRates=\{Object\.fromEntries\(enabledServices\.map/);
  });
  it("the client derives items from the SELECTED service and clears stale counts", () => {
    const ui = read("app/c/order/new/_components/OrderNewClient.tssx".replace(".tssx", ".tsx"));
    expect(ui).toMatch(/const rateItems = allRates\[service\] \?\? \[\]/);
    expect(ui).toMatch(/setService\(sv\); setQuantities\(\{\}\);/);
  });
  it("the subtotal counts cycles on a cycle order, not zero pieces", () => {
    const ui = read("app/c/order/new/_components/OrderNewClient.tsx");
    expect(ui).toMatch(/cycleBased \? `\$\{cycles\} cycle/);
  });
});

describe("urgent (same-day) is a flat fee on cycle services", () => {
  it("Rs 79 Wash & Fold, Rs 99 Wash & Iron — students and faculty alike", async () => {
    const { EXPRESS_FLAT } = await import("../lib/money");
    expect(EXPRESS_FLAT.washFold).toBe(79);
    expect(EXPRESS_FLAT.washIron).toBe(99);
  });
  it("a plan-paid urgent cycle order totals excess + the flat fee, nothing else", async () => {
    const { EXPRESS_FLAT } = await import("../lib/money");
    // 6 kg urgent W&I on a plan: Rs 50 excess + Rs 99 = 149
    const excess = excessWeightCharge(6, undefined, { cycles: 1 });
    expect(computeBill(250, EXPRESS_FLAT.washIron, 18, { usedCycle: true, excessCharge: excess }))
      .toEqual({ gst: 0, total: 149 });
  });
  it("a cash urgent cycle order stays GST-free: 200 + 79 = 279 flat", async () => {
    const { EXPRESS_FLAT } = await import("../lib/money");
    expect(computeBill(200, EXPRESS_FLAT.washFold, 18, { usedCycle: false, excessCharge: 0, noGst: true }))
      .toEqual({ gst: 0, total: 279 });
  });
  it("all three entry points use the flat fee for cycle services", () => {
    // place, accept, walk-in — the 40% formulas survive only for per-piece
    expect(orders.match(/EXPRESS_FLAT\[(input|o)\.service\]/g)?.length).toBe(3);
  });
  it("both apps SAY the flat fee", () => {
    expect(read("app/c/order/new/_components/OrderNewClient.tsx")).toMatch(/Flat \$\{fmt\(EXPRESS_FLAT\[service\]\)\} — same-day/);
    expect(read("app/s/orders/[id]/_components/OrderClient.tsx")).toMatch(/flat same-day fee of ₹\$\{EXPRESS_FLAT\[order\.service\]\}/);
  });
});

describe("Pre-book is alive on cycle orders", () => {
  it("the button no longer gates on pieces, which are always zero for cycles", () => {
    const ui = read("app/c/order/new/_components/OrderNewClient.tsx");
    expect(ui).toMatch(/disabled=\{loading \|\| \(!cycleBased && pieces === 0\)\}/);
  });
});
