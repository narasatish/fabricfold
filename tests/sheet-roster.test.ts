/* The Sheet as a live register (owner, Sep 2026).

   The Plans tab kept showing a removed campus at old prices, and there was
   no Students tab at all — the owner reads this sheet as THE register, and
   a register that lags a day (or a campus) is one nobody trusts. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const sync = read("lib/sheets-sync.ts");

describe("removed campuses leave the sheet", () => {
  it("plans of an inactive college are filtered out — BVRIT stops resurfacing", () => {
    expect(sync).toMatch(/liveCollegeIds = new Set\(colleges\.filter\(\(c\) => c\.active\)/);
    expect(sync).toMatch(/plansAll\.filter\(\(p\) => liveCollegeIds\.has\(p\.collegeId\)\)/);
  });
});

describe("the Students roster tab", () => {
  it("exists, with customer ID, phone, type, plan and cycles left", () => {
    expect(sync).toMatch(/writeSheet\("Students", rows\)/);
    for (const col of ["Customer ID", "Phone", "Type", "Plan", "Cycles left"]) expect(sync).toContain(col);
  });
  it("shows the ACTIVE bag code as the customer ID, falling back to the app id", () => {
    expect(sync).toMatch(/st\.bags\[0\]\?\.code \|\| st\.id/);
  });
  it("counts faculty separately at the foot", () => {
    expect(sync).toMatch(/"Faculty", students\.filter\(\(x\) => x\.kind === "faculty"\)\.length/);
  });
});

describe("the Staff tab", () => {
  it("carries phone and active state now", () => {
    expect(sync).toMatch(/"Staff", "Phone", "Role", "Active"/);
    expect(sync).toMatch(/s\.active \? "yes" : "removed"/);
  });
});

describe("the roster refreshes when it changes, not at 2:30am", () => {
  it("rosterSoon uses after(), same as the outbox — a bare void dies with the instance", () => {
    expect(sync).toMatch(/const \{ after \} = require\("next\/server"\)/);
    expect(sync).toMatch(/after\(run\(\)\)/);
  });
  it("a failed sheet write can never fail a registration", () => {
    expect(sync).toMatch(/catch \(e\) \{ console\.error\("roster sync failed", e\); \}/);
  });
  it("registration, imports, staff and plan changes all trigger it", () => {
    const counts = {
      "lib/actions/admin.ts": 6,        // register, staff add/update/active, student edit, phone
      "lib/actions/subscription.ts": 5, // assign, activate, change, cancel, cycle pack
      "lib/actions/bags.ts": 2,         // customer ID changed / released
      "app/api/import/students/route.ts": 1,
    };
    for (const [f, n] of Object.entries(counts)) {
      expect((read(f).match(/rosterSoon\(\);/g) || []).length, f).toBe(n);
    }
  });
});

describe("install once, never nag again", () => {
  /* Superseded by tests/mobile-fixes.test.ts, which asserts the CORRECT
     shape: one shared singleton (lib/pwa-install.ts) with ONE "ff-installed"
     flag, rather than each component managing its own localStorage. Kept
     here as a pointer so nobody re-adds the old per-component pattern. */
  it("the install memory lives in the shared singleton, not per component", () => {
    const singleton = read("lib/pwa-install.ts");
    expect(singleton).toMatch(/const FLAG = "ff-installed"/);
    for (const f of ["components/install-hint.tsx", "app/get/_components/InstallButton.tsx"]) {
      expect(read(f), f).toMatch(/from "@\/lib\/pwa-install"/);
    }
  });
});
