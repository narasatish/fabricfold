/* Found in the Sep 21 QA pass. SHOW_GST_UI is a blanket "hide GST" switch, but
   the money code still ADDS GST on top of per-piece prices whenever GST billing
   is on (Admin toggle). With GST off (today's setting) hiding the line is right;
   the day it is switched on, students would pay more than the rate they were
   shown with no line explaining it. A GST line must show whenever GST is
   actually charged, and stay hidden when it is zero. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { gstLineVisible } from "../lib/money";

const read = (f: string) => fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");

describe("gstLineVisible", () => {
  it("hidden when no GST is charged (today's GST-off setting)", () => {
    expect(gstLineVisible(0)).toBe(false);
    expect(gstLineVisible(NaN)).toBe(false);
  });
  it("visible whenever GST is actually charged", () => {
    expect(gstLineVisible(27)).toBe(true);
    expect(gstLineVisible(0.5)).toBe(true);
  });
});

describe("no bill screen hides charged GST behind the blanket flag", () => {
  const screens = [
    "app/c/order/new/_components/OrderNewClient.tsx",
    "app/c/orders/[id]/page.tsx",
    "app/c/wallet/_components/WalletClient.tsx",
    "app/s/customers/[id]/_components/CustomerClient.tsx",
    "app/s/orders/[id]/_components/OrderClient.tsx",
  ];
  for (const f of screens) {
    it(`${f} never uses SHOW_GST_UI on its own`, () => {
      const src = read(f);
      // Any remaining use must be OR-ed with the real amount (gstLineVisible), never a bare `SHOW_GST_UI &&`.
      expect(src).not.toMatch(/SHOW_GST_UI\s*&&/);
    });
  }
});
