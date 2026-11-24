/* Found live 2026-11-23, right after deploying the staff QR scanner: the
   production Permissions-Policy header was still `camera=()` from before
   this app had any camera feature — set deliberately ("the app never
   needs these browser powers") when that was true. Left as-is, it would
   have silently blocked getUserMedia on every real phone, no matter how
   correct app/s/scan's own code was; confirmed via curl against the live
   site immediately after the first deploy. Fixed to `camera=(self)`.
   This locks the fix in so a future "harden the headers" pass doesn't
   quietly revert it without realizing the scanner depends on it. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const CONFIG = fs.readFileSync(path.resolve(__dirname, "../next.config.ts"), "utf8");

describe("the Permissions-Policy header allows this origin to use the camera", () => {
  it("camera is scoped to (self), not denied outright", () => {
    const line = CONFIG.split("\n").find((l) => l.includes("Permissions-Policy"));
    expect(line).toBeDefined();
    expect(line).toMatch(/camera=\(self\)/);
    expect(line).not.toMatch(/camera=\(\)/);
  });

  it("microphone and geolocation stay denied — the app has no feature needing them", () => {
    const line = CONFIG.split("\n").find((l) => l.includes("Permissions-Policy"));
    expect(line).toMatch(/microphone=\(\)/);
    expect(line).toMatch(/geolocation=\(\)/);
  });
});
