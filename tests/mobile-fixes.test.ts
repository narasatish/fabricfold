/* Owner's live-device bug reports, second round.

   Each was found by using the real app on a real phone, not by reading code
   — which is exactly why they survived a passing test suite. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");

describe("staff Place order was dead on cycle services", () => {
  it("no longer gates on pieces, which are always zero for washFold/washIron", () => {
    const ui = read("app/s/customers/[id]/_components/CustomerClient.tsx");
    // isCycleService(wiService) became wiCycleBased (college-aware — see
    // collegeUsesCycleBasedPricing) when BVRIT's per-piece pricing landed,
    // but the underlying fix this test guards — no longer gating on pieces
    // for a cycle service — is unchanged.
    expect(ui).toMatch(/disabled=\{wiLoading \|\| \(!wiCycleBased && wiPieces === 0\)\}/);
  });
});

describe("the 40% commission model is gone, not just hidden", () => {
  it("EXPRESS_PCT, expressSurcharge and urgentCycleCharge no longer exist in money.ts", () => {
    const money = read("lib/money.ts");
    expect(money).not.toMatch(/export const EXPRESS_PCT/);
    expect(money).not.toMatch(/export function expressSurcharge/);
    expect(money).not.toMatch(/export function urgentCycleCharge/);
  });
  it("expressFlatFee covers every service the owner named, with a safe fallback", () => {
    const money = read("lib/money.ts");
    expect(money).toMatch(/washFold: 79, washIron: 99, dryClean: 79, ironOnly: 79/);
    expect(money).toMatch(/EXPRESS_FLAT\[service\] \?\? EXPRESS_FLAT\.washFold/);
  });
  it("no order-placing path still imports the retired functions", () => {
    for (const f of [
      "lib/actions/orders.ts",
      "app/c/order/new/_components/OrderNewClient.tsx",
      "app/c/order/new/page.tsx",
      "app/s/orders/[id]/_components/OrderClient.tsx",
      "app/s/customers/[id]/_components/CustomerClient.tsx",
    ]) {
      expect(read(f), f).not.toMatch(/EXPRESS_PCT|expressSurcharge|urgentCycleCharge|urgentCyclePreview/);
    }
  });
  it("the terms page states the real flat fees, not a percentage", () => {
    const terms = read("app/terms/page.tsx");
    expect(terms).not.toMatch(/40%/);
    expect(terms).toMatch(/₹99 Wash & Iron, ₹79 Wash & Fold and Dry Cleaning/);
  });
  it("every surcharge call site uses the flat fee unconditionally — cash or plan-paid, any service", () => {
    // expressFlatFee became collegeExpressFee (college-aware) once BVRIT's
    // per-college express pricing landed — still all 5 call sites, still
    // unconditional.
    const orders = read("lib/actions/orders.ts");
    expect(orders.match(/collegeExpressFee\((input|o)\.service, cfg\.collegeExpressOverride\)/g)?.length).toBe(5);
  });
});

describe("one install listener for the whole site, not three racing ones", () => {
  it("the singleton is armed from the root layout — the earliest any client code runs", () => {
    expect(read("components/pwa.tsx")).toMatch(/armInstallListener\(\);/);
    expect(read("app/layout.tsx")).toMatch(/PwaSetup/);
  });
  it("all three surfaces read the SAME singleton instead of attaching their own listener", () => {
    for (const f of ["components/pwa.tsx", "app/get/_components/InstallButton.tsx", "components/install-hint.tsx"]) {
      const src = read(f);
      expect(src, f).toMatch(/from "@\/lib\/pwa-install"/);
      expect(src, f).not.toMatch(/addEventListener\("beforeinstallprompt"/);
    }
  });
  it("a component that mounts AFTER the event fired still sees it (no missed-event race)", () => {
    const singleton = read("lib/pwa-install.ts");
    expect(singleton).toMatch(/export function getDeferredPrompt/);
    // deferred is a MODULE-level variable, not component state — it survives
    // whichever component asks, mounted before or after the event fired
    expect(singleton).toMatch(/^let deferred: BIPEvent \| null = null;/m);
  });
  it("installing anywhere sets ONE flag that silences every surface", () => {
    const singleton = read("lib/pwa-install.ts");
    expect(singleton).toMatch(/const FLAG = "ff-installed"/);
    for (const f of ["components/pwa.tsx", "app/get/_components/InstallButton.tsx", "components/install-hint.tsx"]) {
      expect(read(f), f).toMatch(/isInstalled\(\)/);
    }
  });
  it("a used or dismissed prompt is cleared, so a stale second tap cannot silently no-op", () => {
    expect(read("lib/pwa-install.ts")).toMatch(/const p = deferred;\s*\n\s*deferred = null;/);
  });
});

describe("iPhone: content no longer cuts off behind the notch or the tab bar", () => {
  it("the tab bar's real height (content + home-indicator inset) is what screens pad for, not a flat guess", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/\.screen\{[^}]*padding-bottom:calc\(88px \+ env\(safe-area-inset-bottom\)\)/);
  });
  it("the top bar clears the status bar / notch in standalone mode", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/\.topbar\{[^}]*padding:calc\(14px \+ env\(safe-area-inset-top\)\)/);
  });
  it("the app shell respects the side notches too (landscape / Dynamic Island)", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/#app\{[^}]*padding-left:env\(safe-area-inset-left\);padding-right:env\(safe-area-inset-right\)/);
  });
  it("viewport-fit:cover is set — without it the safe-area env() variables are always zero", () => {
    expect(read("app/layout.tsx")).toMatch(/viewportFit: "cover"/);
  });
});
