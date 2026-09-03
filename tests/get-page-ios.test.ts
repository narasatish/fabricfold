/* "I can't download the app on iPhone using the QR" — the honest fix.

   iPhone genuinely cannot one-tap install from a browser; Apple provides no
   install event for Safari to fire, on any iOS version, for any web app.
   The bug was presentation: a 4-second "Checking your phone…" ran on iPhone
   too, before finally showing instructions that were the real answer all
   along — reading as a stuck or broken button rather than a normal iPhone
   step. Fixed by detecting iOS up front and skipping the wait entirely, and
   by saying explicitly that this is not a bug. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");

describe("InstallButton no longer makes an iPhone wait for an event that never fires", () => {
  it("detects iOS Safari synchronously and skips straight past the checking state", () => {
    const src = read("app/get/_components/InstallButton.tsx");
    expect(src).toMatch(/if \(isIosSafari\(\)\) \{ setState\("unsupported"\); return; \}/);
  });
  it("the iOS check runs BEFORE the 4-second timeout is ever set", () => {
    const src = read("app/get/_components/InstallButton.tsx");
    const iosCheck = src.indexOf("isIosSafari()");
    const timeout = src.indexOf("setTimeout");
    expect(iosCheck).toBeGreaterThan(-1);
    expect(iosCheck).toBeLessThan(timeout);
  });
  it("excludes Chrome/Firefox/Edge running on iOS — they are Safari underneath but still lack the install API the same way", () => {
    const src = read("app/get/_components/InstallButton.tsx");
    expect(src).toMatch(/!\/crios\|fxios\|edgios\/i\.test\(ua\)/);
  });
});

describe("the iPhone card says plainly this is not a broken button", () => {
  it("states Apple's own restriction, so 3 manual taps reads as normal, not broken", () => {
    const src = read("app/get/_components/PlatformInstructions.tsx");
    expect(src).toMatch(/Apple doesn&apos;t allow one-tap install/);
    expect(src).toMatch(/a broken button; it&apos;s the real, complete path/);
  });
  it("warns explicitly against Chrome on iPhone — it cannot Add to Home Screen there", () => {
    const src = read("app/get/_components/PlatformInstructions.tsx");
    expect(src).toMatch(/not Chrome — Chrome on iPhone can&apos;t add to Home Screen/);
  });
  it("the iPhone card shows FIRST when an iPhone is detected", () => {
    const src = read("app/get/_components/PlatformInstructions.tsx");
    expect(src).toMatch(/return ios \? <>\{iphoneCard\}\{androidCard\}<\/> : <>\{androidCard\}\{iphoneCard\}<\/>/);
  });
  it("shows something even before JS detection resolves — never a blank page", () => {
    const src = read("app/get/_components/PlatformInstructions.tsx");
    expect(src).toMatch(/if \(ios === null\) return <>\{iphoneCard\}\{androidCard\}<\/>/);
  });
});

describe("the page wires both pieces together", () => {
  it("PlatformInstructions replaced the old static, UA-blind card pair", () => {
    const page = read("app/get/page.tsx");
    expect(page).toMatch(/<PlatformInstructions \/>/);
    expect(page).not.toMatch(/<div className="h-sm">iPhone<\/div>/);
  });
});
