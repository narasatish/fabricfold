/* Free-text fields that accepted any length (found in the Sep 21 QA pass): complaint
   messages, the damage comment, the resolution note, bag notes, compensation and
   day-close comments, erasure reasons. Long text bloats the database, the Sheet and
   the notifications sent to students. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (f: string) => fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");
const body = (src: string, name: string) => { const i = src.indexOf(`export async function ${name}`); return src.slice(i, src.indexOf("\nexport async function ", i + 10)); };

describe("free text is length-limited", () => {
  const c = read("lib/actions/complaints.ts");
  it("complaint messages (student and staff) <= 2000", () => expect(body(c, "sendComplaintMessage")).toMatch(/t\.length > 2000/));
  it("the damage comment <= 2000", () => expect(body(c, "reportOrderDamage")).toMatch(/comment\.length > 2000/));
  it("the resolution note <= 500", () => expect(body(c, "resolveComplaint")).toMatch(/res\.length > 500/));
  it("compensation comment <= 300", () => expect(body(read("lib/actions/credits.ts"), "submitCompensation")).toMatch(/comment.*length > 300/));
  it("bag notes are capped", () => expect((read("lib/actions/bags.ts").match(/slice\(0, 200\)/g) || []).length).toBeGreaterThanOrEqual(3));
  it("day-close note and erasure reason are capped", () => {
    expect(read("lib/actions/ops.ts")).toMatch(/note\?\.trim\(\)\.slice\(0, 200\)/);
    expect(read("lib/actions/privacy.ts")).toMatch(/\.trim\(\)\.slice\(0, 300\)/);
  });
});

describe("cancelSubscription reason", () => {
  it("is capped, same as other admin-typed reasons", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "..", "lib/actions/subscription.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function cancelSubscription"), src.indexOf("export async function cancelSubscription") + 800);
    expect(fn).toMatch(/note\.length > 300/);
  });
});
