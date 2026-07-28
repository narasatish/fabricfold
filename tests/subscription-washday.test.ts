/* Guarantees that turning on a subscription never disturbs an EXISTING
   wash-day assignment, and only fills one in for a student who doesn't have
   one yet (e.g. registered before the feature existed).

   activateSubscription/assignSubscription both call requireStaff(), which
   reads the session from next/headers cookies() — same constraint noted in
   registration-lockdown.test.ts, so this asserts the guard at the source
   level rather than driving a live session. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.resolve(__dirname, "../lib/actions/subscription.ts"), "utf8");

function body(fnName: string) {
  const start = src.indexOf(`export async function ${fnName}`);
  expect(start, `${fnName} not found`).toBeGreaterThan(-1);
  const nextExport = src.indexOf("\nexport async function", start + 1);
  return src.slice(start, nextExport === -1 ? undefined : nextExport);
}

describe("subscription activation never reassigns an existing wash day", () => {
  it("activateSubscription only assigns a wash day when the student doesn't already have one", () => {
    const fn = body("activateSubscription");
    expect(fn).toMatch(/stu\.washDay === null/);
    expect(fn).toMatch(/assignWashDay\(stu\.id, stu\.collegeId\)/);
    // must be conditional -- an unconditional call would silently reshuffle
    // an existing student onto a different day every time they resubscribe
    expect(fn).not.toMatch(/^\s*await assignWashDay/m);
  });

  it("assignSubscription (Manager+ direct assign) has the same guard", () => {
    const fn = body("assignSubscription");
    expect(fn).toMatch(/stu\.washDay === null/);
    expect(fn).toMatch(/assignWashDay\(stu\.id, stu\.collegeId\)/);
    expect(fn).not.toMatch(/^\s*await assignWashDay/m);
  });

  it("requestSubscription (just a pending request, not yet active) never touches wash day at all", () => {
    const fn = body("requestSubscription");
    expect(fn).not.toMatch(/washDay/);
    expect(fn).not.toMatch(/assignWashDay/);
  });
});
