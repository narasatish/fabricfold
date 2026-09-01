/* Wash day is PARKED (owner, Sep 2026): students drop off any day, so no
   path assigns one any more. These tests pin the parked state — the old
   guarantee ("never REASSIGN an existing day") is vacuously kept by assigning
   nothing at all, and the balancing code survives untouched for the return. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const sub = read("lib/actions/subscription.ts");

describe("wash day stays parked", () => {
  it("no subscription path assigns a day", () => {
    expect(sub).not.toMatch(/await assignWashDay\(/);
  });
  it("registration doesn't either", () => {
    expect(read("lib/actions/students.ts")).not.toMatch(/await assignWashDay\(/);
    expect(read("lib/actions/admin.ts")).not.toMatch(/await assignWashDay\(/);
  });
  it("an existing day is never overwritten — the column is left alone", () => {
    // activation/upgrade must not touch washDay at all while parked
    expect(sub).not.toMatch(/washDay:/);
  });
  it("the balancer itself survives for when the rota returns", () => {
    expect(read("lib/washday-server.ts")).toMatch(/export async function assignWashDay/);
  });
});
