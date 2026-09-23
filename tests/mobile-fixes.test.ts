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
    // for a cycle service — is unchanged. A second clause was added Sep 22
    // (mandatory weight on a cycle order), so this only checks the pieces
    // clause survived, not the exact whole expression any more.
    expect(ui).toMatch(/disabled=\{wiLoading \|\| \(!wiCycleBased && wiPieces === 0\)/);
  });
});

describe("the pickup code must come from the student, not be readable off staff's own screen (owner, Sep 23)", () => {
  it("the staff order page never fetches the pickup OTP at all", () => {
    // Not just hidden in the UI — a value the server never sends can't be
    // read from devtools/view-source either. The only correct fix is to
    // never fetch it here in the first place.
    const page = read("app/s/orders/[id]/page.tsx");
    expect(page).not.toMatch(/purpose: "pickup"/);
    expect(page).not.toMatch(/expectedPickupCode/);
  });
  it("the collect sheet has no 'Expected code' answer key", () => {
    const ui = read("app/s/orders/[id]/_components/OrderClient.tsx");
    expect(ui).not.toMatch(/Expected code/);
    expect(ui).not.toMatch(/expectedPickupCode/);
  });
  it("the collect sheet tells staff to ask, not just type whatever they already see (owner: staff may see the order number, but must verify it WITH the student)", () => {
    const ui = read("app/s/orders/[id]/_components/OrderClient.tsx");
    expect(ui).toMatch(/Ask the student for their 4-digit pickup code/);
    expect(ui).toMatch(/always have the student say or show it themselves/);
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
  it("every flat-fee call site still exists — now gated to cycle colleges only (BVRIT prices express per-piece instead, Sep 2026)", () => {
    // expressFlatFee became collegeExpressFee (college-aware) once BVRIT's
    // per-college express pricing landed; still all 5 call sites, each now
    // gated on usesCycles (see cycle-model.test.ts) rather than unconditional.
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

describe("a cancelled subscription is not indistinguishable from a pending one (found live, Sep 23)", () => {
  const ui = read("app/s/customers/[id]/_components/CustomerClient.tsx");
  it("the page fetches the cancellation fields, not just active/expiresAt", () => {
    const page = read("app/s/customers/[id]/page.tsx");
    expect(page).toMatch(/cancelledAt: student\.subscription\.cancelledAt/);
    expect(page).toMatch(/cancelledReason: student\.subscription\.cancelledReason/);
  });
  it("the status pill says Cancelled, not Pending, once cancelledAt is set", () => {
    expect(ui).toMatch(/student\.subscription\.active \? "Active" : student\.subscription\.cancelledAt \? "Cancelled" : "Pending"/);
  });
  it("shows the recorded reason and date — the whole point of storing them", () => {
    expect(ui).toMatch(/student\.subscription\.cancelledAt && \(/);
    expect(ui).toMatch(/cancelledReason/);
  });
  it("Change plan, Correct cycles used and Cancel plan all require an ACTIVE subscription, not just that one exists", () => {
    // Previously staffRole alone gated these, so a dead (cancelled) plan
    // still offered "Change plan" — clicking it hit upgradeSubscription's
    // own "no active plan to change" error, a dead-end round trip.
    const block = ui.slice(ui.indexOf('{/* Subscription */}'), ui.indexOf('{/* Subscription */}') + 3000);
    expect(block.match(/student\.subscription\.active &&/g)?.length).toBeGreaterThanOrEqual(3);
  });
  it("the cancelled note only shows while inactive — a re-activated plan can carry a stale cancelledAt from before", () => {
    // Found live, Sep 23: re-assigning a plan that had been cancelled earlier
    // the same day left the OLD cancelledAt/cancelledReason on the row (see
    // lib/plan-activation.ts, now cleared on activation) — this is the other
    // half of the fix, since a page rendered from a stale row must not show
    // "Cancelled: ..." next to an Active pill either way.
    expect(ui).toMatch(/!student\.subscription\.active && student\.subscription\.cancelledAt && \(/);
  });
  it("activatePlan clears any earlier cancellation when it (re)activates a subscription", () => {
    const activation = read("lib/plan-activation.ts");
    expect(activation).toMatch(/cancelledAt: null, cancelledReason: null, cancelledBy: null/);
  });
});

describe("Admin App Errors panel actually clears on Mark reviewed (found live, Sep 23)", () => {
  it("the query filters out already-seen errors instead of showing the last 15 regardless", () => {
    // Found live: a 2-day-old, already-reviewed error (seen:true in the DB)
    // was still showing on the Admin page — the query never filtered on
    // `seen` at all, it just took the 15 most recent errors. The owner read
    // stale, already-dismissed noise as a fresh crash. Confirmed zero
    // unseen errors existed in production at the time.
    const src = read("app/s/admin/page.tsx");
    expect(src).toMatch(/db\.errorLog\.findMany\(\{ where: \{ seen: false \}, orderBy: \{ at: "desc" \}, take: 15 \}\)/);
  });
});

describe("submitCompensation caps the amount like every other money action (found by audit, Sep 23)", () => {
  it("rejects Infinity and absurdly large amounts, not just <= 0", () => {
    // `!amount || amount <= 0` alone lets Infinity through — it's truthy and
    // not <= 0 — reaching `credits: { increment: Infinity }` and permanently
    // corrupting the student's wallet balance. topUpCredits already guarded
    // against this (lib/actions/ops.ts); submitCompensation never matched it.
    const credits = read("lib/actions/credits.ts");
    expect(credits).toMatch(/if \(!amount \|\| amount <= 0 \|\| amount > 50_000\) return \{ ok: false as const, error: "Enter a valid amount" \};/);
  });
});

describe("compensation is credit-only, capped at ₹2,000 for staff below Admin (owner, Sep 23)", () => {
  const credits = read("lib/actions/credits.ts");
  it("cash compensation is retired — method is no longer a caller-supplied input", () => {
    expect(credits).not.toMatch(/method: "credit" \| "cash"/);
    expect(credits).not.toMatch(/"cash_out"/);
  });
  it("every grant still lands as store credit, unconditionally", () => {
    expect(credits).toMatch(/await tx\.student\.update\(\{ where: \{ id: stu\.id \}, data: \{ credits: \{ increment: amount \} \} \}\);/);
  });
  it("staff below Admin (role 3) are capped at ₹2,000; Admin/Owner can go higher", () => {
    expect(credits).toMatch(/const STAFF_COMP_CAP = 2000;/);
    expect(credits).toMatch(/if \(amount > STAFF_COMP_CAP && st\.role < 3\)/);
  });
  it("the three staff-facing compensation forms no longer offer a cash option", () => {
    for (const f of [
      "app/s/customers/[id]/_components/CustomerClient.tsx",
      "app/s/complaints/_components/ComplaintsClient.tsx",
      "app/s/orders/[id]/_components/OrderClient.tsx",
    ]) {
      const ui = read(f);
      expect(ui, f).not.toMatch(/method: "credit" \| "cash"/);
      // Scoped to the compensation Method selector specifically — other Seg
      // pickers on these same pages (wallet top-up, bag fee, plan upgrade)
      // legitimately still offer cash/UPI as a payment method.
      expect(ui, f).not.toMatch(/\["credit", "Store credit"\], \["cash", "Cash"\]/);
    }
  });
});

describe("grantFreeReservice claims the complaint BEFORE creating the free order, not after (found by audit, Sep 23)", () => {
  const complaints = read("lib/actions/complaints.ts");
  it("the sentinel claim runs before redoOrder() is called", () => {
    // Claiming after redoOrder() meant two concurrent clicks could both pass
    // the redoOrderId-null check, both create a real free-service order, and
    // only the LOSER's attempt to link its own order back to the complaint
    // failed — leaving its order as an untraceable orphaned duplicate free
    // wash. The order must never be created before the claim succeeds.
    const claimIdx = complaints.indexOf('data: { redoOrderId: "claiming" }');
    const redoCallIdx = complaints.indexOf("r = await redoOrder(c.orderId);");
    expect(claimIdx).toBeGreaterThan(-1);
    expect(redoCallIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeLessThan(redoCallIdx);
  });
  it("releases the sentinel if redoOrder() fails, so a retry isn't permanently blocked", () => {
    expect(complaints).toMatch(/where: \{ id: complaintId, redoOrderId: "claiming" \}, data: \{ redoOrderId: null \}/);
  });
  it("also releases the sentinel if redoOrder() THROWS, not just when it returns ok:false", () => {
    // Found testing the fix above: redoOrder() throws (findUniqueOrThrow on
    // a bad orderId) rather than returning ok:false in that case, and a
    // plain if-check after an un-caught call misses it — the sentinel stuck
    // at "claiming" forever, permanently blocking the complaint from ever
    // getting a free re-service. There must be a try/catch around the call.
    const tryIdx = complaints.indexOf("try {");
    expect(tryIdx).toBeGreaterThan(-1);
    const catchBlock = complaints.slice(tryIdx, tryIdx + 300);
    expect(catchBlock).toMatch(/catch \(e\) \{/);
    expect(catchBlock).toMatch(/redoOrderId: "claiming" \}, data: \{ redoOrderId: null \}/);
  });
});
