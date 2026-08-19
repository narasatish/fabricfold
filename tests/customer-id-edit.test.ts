/* Editing a student's customer ID.

   The counter sometimes has a specific printed bag in hand and the student
   must end up with the number on it. Renaming the existing bag keeps one row
   and one history rather than leaving a second code drifting about. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const bags = read("lib/actions/bags.ts");
const fn = bags.slice(bags.indexOf("export async function setBagCode"));
const ui = read("app/s/customers/[id]/_components/CustomerClient.tsx");

describe("who may change it", () => {
  it("Admin or above — it is the student's identity", () => {
    expect(fn.slice(0, 200)).toMatch(/requireStaff\(3\)/);
  });
  it("both the old and new value are audited", () => {
    expect(fn).toMatch(/audit\("Customer ID changed", `\$\{bag\.student\.name\} · \$\{before\} → \$\{code\}`/);
  });
  it("the student is told, since they quote this number", () => {
    expect(fn).toMatch(/Your FabricFold customer ID is now/);
  });
});

describe("what it refuses", () => {
  it("a malformed code", () => {
    expect(fn).toMatch(/Use a code like B001, S042 or G250/);
  });
  it("a letter that contradicts their plan", () => {
    // the letter is what staff read to know the entitlement
    expect(fn).toMatch(/so the code must start with/);
    expect(fn).toMatch(/parsed\.kind !== expected/);
  });
  it("a code another live student holds — by name, not a raw error", () => {
    expect(fn).toMatch(/is already held by \$\{clash\.student\.name\}/);
  });
  it("a released bag — that code belongs to the pool now", () => {
    expect(fn).toMatch(/This code has been released/);
  });
});

describe("it cannot be raced", () => {
  it("falls back to the unique index if two edits collide", () => {
    // the pre-check is for a readable message; the index is the guarantee
    expect(fn).toMatch(/code === "P2002"/);
    expect(fn).toMatch(/was just taken by someone else/);
  });
});

describe("propagation", () => {
  it("writes the ONE row every screen reads", () => {
    /* Verified against the live schema too: no other table caches a bag code,
       so there is nothing that can go stale. */
    expect(fn).toMatch(/db\.bag\.update\(\{ where: \{ id: bagId \}, data: \{ code \} \}\)/);
  });

  it("does not touch the student row", () => {
    // orders, payments and invoices reference the student, not the code
    expect(fn).not.toMatch(/student\.update/);
  });

  it("pushes a realtime event so open screens refresh", () => {
    expect(fn).toMatch(/publish\(\[`student:\$\{bag\.studentId\}`/);
  });

  it("is reachable from the staff card", () => {
    expect(ui).toMatch(/Change ID/);
    expect(ui).toMatch(/setBagCode\(bagId, next\)/);
  });
});
