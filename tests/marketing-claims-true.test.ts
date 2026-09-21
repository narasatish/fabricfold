/* Found in the Sep 21 QA pass: the public site promised per-garment QR tags and
   GST invoices on UPI payments, but garment tagging is parked (default OFF in
   lib/actions/orders.ts) and GST billing is off in production - so the site
   advertised things that were not happening. The copy now says what is true
   (pieces are counted at drop-off and again before collection). If garment tagging
   or GST billing is switched on for real, update the copy AND this test together. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const FILES = [
  "app/page.tsx", "app/about/page.tsx", "app/how-it-works/page.tsx", "app/hostel-laundry/page.tsx",
  "app/partners/page.tsx", "app/refunds/page.tsx", "app/_components/marketing/Home.tsx",
];
const src = (f: string) => fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");

describe("public copy does not promise what the app isn't doing", () => {
  for (const f of FILES) {
    it(`${f}: no QR-tag promises`, () => expect(src(f)).not.toMatch(/QR[- ]tag|scannable QR|own QR code/i));
    it(`${f}: no unconditional GST-invoice promise`, () => expect(src(f)).not.toMatch(/downloadable GST invoice|payment and GST invoice|and GST invoice is recorded/i));
  }
  it("about: no 'we mean it' guarantee that the Terms contradict", () => {
    expect(src("app/about/page.tsx")).not.toMatch(/we mean it/i);
  });
  it("the Terms still call turnaround a target, not a guarantee (so the copy above must too)", () => {
    expect(src("app/terms/page.tsx")).toMatch(/not a guarantee/i);
  });
});
