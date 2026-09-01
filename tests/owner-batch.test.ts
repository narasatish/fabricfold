/* The Sep-2026 owner batch: 5 kg / Rs 50 flat / round-up excess with waiver,
   4-digit bag codes, parked wash day, batch advance, uncollected list,
   weekly digest, variance alert, sign-in audit, QR removals, /get page. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { excessWeightCharge, CYCLE_KG_LIMIT, EXCESS_PER_KG } from "../lib/money";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");

describe("overweight — 5 kg, Rs 50, round UP", () => {
  it("is 5 kg and Rs 50 flat", () => {
    expect(CYCLE_KG_LIMIT).toBe(5);
    expect(EXCESS_PER_KG).toBe(50);
  });
  it("rounds a started kilogram up: 5.2 kg bills as 1 kg over", () => {
    // a scale reading 5.2 then 5.4 must not change the price
    expect(excessWeightCharge(5.2)).toBe(50);
    expect(excessWeightCharge(6)).toBe(50);
    expect(excessWeightCharge(6.01)).toBe(100);
    expect(excessWeightCharge(8)).toBe(150);
  });
  it("charges nothing at or under the limit", () => {
    expect(excessWeightCharge(5)).toBe(0);
    expect(excessWeightCharge(4.9)).toBe(0);
    expect(excessWeightCharge(null)).toBe(0);
  });
  it("waived means zero, whatever the weight", () => {
    expect(excessWeightCharge(12, undefined, { waived: true })).toBe(0);
  });
  it("the waiver is recorded with who did it", () => {
    const src = read("lib/actions/orders.ts");
    expect(src).toMatch(/audit\("Excess weight waived"/);
    // and only when there was actually something to waive
    expect(src).toMatch(/input\.waiveExcess && Number\(input\.weightKg\) > CYCLE_KG_LIMIT/);
  });
  it("the accept sheet quotes the same rounded number that bills", () => {
    const ui = read("app/s/orders/[id]/_components/OrderClient.tsx");
    expect(ui).toMatch(/Math\.ceil\(overKg\)/);
    expect(ui).toMatch(/Waive excess charge/);
  });
});

describe("wash day — parked, not deleted", () => {
  it("no path assigns a day any more", () => {
    for (const f of ["lib/actions/admin.ts", "lib/actions/subscription.ts", "lib/actions/students.ts"]) {
      expect(read(f)).not.toMatch(/await assignWashDay\(/);
    }
  });
  it("the balancing code itself survives for the return", () => {
    expect(read("lib/washday-server.ts")).toMatch(/export async function assignWashDay/);
  });
});

describe("notifications actually leave the building", () => {
  it("pushNotif delivers via after(), not a floating promise", () => {
    /* A bare .then chain is abandoned when Vercel freezes the instance — the
       same failure that once left Sheet rows unsent for hours. */
    const src = read("lib/notify.ts");
    expect(src).toMatch(/after\(deliver\(\)\)/);
    expect(src).not.toMatch(/sendPushTo\("student", studentId, \{ title: "FabricFold", body: text \}\)\.catch\(\(\) => \{\}\);\n  db\.student/);
  });
});

describe("batch advance", () => {
  const src = read("lib/actions/orders.ts");
  it("reports per-order outcomes instead of failing the whole batch", () => {
    expect(src).toMatch(/const failed: \{ id: string; error: string \}\[\] = \[\]/);
  });
  it("caps and dedupes the selection", () => {
    expect(src).toMatch(/\[\.\.\.new Set\(orderIds\)\]\.slice\(0, 50\)/);
  });
  it("goes through advanceStatus itself — same rules, better ergonomics", () => {
    const fn = src.slice(src.indexOf("export async function advanceStatusBatch"), src.indexOf("export async function advanceStatus("));
    expect(fn).toMatch(/await advanceStatus\(id\)/);
  });
  it("the queue offers it, and collection stays one at a time", () => {
    const ui = read("app/s/_components/HomeClient.tsx");
    expect(ui).toMatch(/Select many/);
    expect(ui).toMatch(/o\.status === "received" \|\| o\.status === "processing"/);
  });
});

describe("uncollected 5+ days", () => {
  it("ages from the ready EVENT, not the order date", () => {
    expect(read("app/s/page.tsx")).toMatch(/timeline: \{ where: \{ status: "ready" \}/);
    expect(read("app/s/_components/HomeClient.tsx")).toMatch(/o\.readyAt !== null && Date\.now\(\) - o\.readyAt > 5 \* 86_400_000/);
  });
});

describe("weekly digest + variance alert", () => {
  it("digest cron exists and is authorised", () => {
    const src = read("app/api/cron/weekly-digest/route.ts");
    expect(src).toMatch(/Bearer \$\{secret\}/);
    expect(src).toMatch(/UNCOLLECTED 5\+ DAYS/);
  });
  it("is scheduled weekly — Hobby allows at most daily", () => {
    const v = JSON.parse(read("vercel.json"));
    const c = v.crons.find((x: { path: string }) => x.path === "/api/cron/weekly-digest");
    expect(c.schedule).toBe("30 3 * * 1");
  });
  it("variance over Rs 200 escalates and the mail is awaited", () => {
    const src = read("lib/actions/ops.ts");
    expect(src).toMatch(/Math\.abs\(variance\) > 200/);
    expect(src).toMatch(/await notifyOwner\(/);
    expect(src).not.toMatch(/void notifyOwner\(\n\s+`Day closed/);
  });
});

describe("every sign-in is recorded", () => {
  it("all four paths write the audit row", () => {
    const auth = read("lib/actions/auth.ts");
    expect(auth.match(/recordSignIn\(/g)!.length).toBeGreaterThanOrEqual(4); // def + 3 calls
    expect(read("lib/actions/wa-login.ts")).toMatch(/Student sign-in.*via whatsapp/);
  });
  it("a failed log line never blocks the login", () => {
    expect(read("lib/actions/auth.ts")).toMatch(/catch \{ \/\* a failed log line must never block a login \*\/ \}/);
  });
});

describe("QR removals — payment QR stays", () => {
  it("customer home and staff customer page lost their QRs", () => {
    expect(read("app/c/page.tsx")).not.toMatch(/<Qr /);
    expect(read("app/s/customers/[id]/_components/CustomerClient.tsx")).not.toMatch(/<Qr /);
  });
  it("the UPI payment QR is untouched — students pay with it", () => {
    expect(read("app/c/pay/[id]/_components/PayClient.tsx")).toMatch(/<Qr text=\{upiLink/);
  });
  it("the poster page reuses the app's own QR generator", () => {
    expect(read("app/get/poster/page.tsx")).toMatch(/<Qr text="https:\/\/fabricfold\.in\/get"/);
  });
});

describe("the import route", () => {
  const src = read("app/api/import/students/route.ts");
  it("is Admin+ and refuses anonymous uploads", () => {
    expect(src).toMatch(/requireStaff\(3\)/);
  });
  it("mints NO payment and NO invoice — gap-free numbering is the law", () => {
    expect(src).not.toMatch(/payment\.create|createInvoice/);
  });
  it("honours the printed customer ID exactly", () => {
    expect(src).toMatch(/code: codeRaw/);
  });
  it("the bag letter beats the amount when they disagree", () => {
    expect(src).toMatch(/the bag letter wins/);
  });
  it("skips an existing mobile rather than overwriting", () => {
    expect(src).toMatch(/already registered/);
  });
  it("bumps the allocator past every imported number", () => {
    // otherwise "sell a bag" could mint a code the owner already printed
    expect(src).toMatch(/row\.value < maxN/);
  });
  it("refuses a code already on someone's active bag", () => {
    expect(src).toMatch(/status: "active" \}, include: \{ student: true \}/);
  });
});

describe("import refuses a broken plan", () => {
  it("a plan with zero cycles cannot mint subscriptions", () => {
    // active on paper, unusable at the counter — refuse with the fix named
    const src = fs.readFileSync(path.resolve(__dirname, "..", "app/api/import/students/route.ts"), "utf8");
    expect(src).toMatch(/has no cycles configured/);
    expect(src).toMatch(/reduce\(\(n, b\) => n \+ \(b\.cycles \|\| 0\), 0\) === 0/);
  });
});
