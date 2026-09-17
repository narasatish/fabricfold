/* Found live 2026-09-17: lib/auth.ts and proxy.ts both fell back to a
   hardcoded, publicly-known string ("dev-secret") when AUTH_SECRET was
   unset — every session JWT would be signed (and verified) with that same
   string, forgeable by anyone who reads the source. Compare
   lib/cron-auth.ts's isCronRequest(), which correctly fails CLOSED (rejects
   every request) when ITS secret is unset: the same class of
   misconfiguration (a forgotten Render env var) must not have a WORSE
   outcome for the session cookie gating every /s and /c page. Fixed with a
   module-load guard that refuses to start in production without a real
   secret. Source-asserted (not a dynamic re-import under a mocked
   NODE_ENV) to match this codebase's own established pattern for this
   class of guard — see route-boundary.test.ts's identical style for the
   OTP-undeliverable-in-production check — and to avoid re-importing
   lib/auth.ts's module-level db singleton under vi.resetModules(), which
   risks cross-test pollution for no real gain over asserting the guard
   text directly. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");

describe("AUTH_SECRET fails closed in production, not open to a public fallback", () => {
  it("lib/auth.ts refuses to start in production with no AUTH_SECRET", () => {
    const src = read("lib/auth.ts");
    expect(src).toMatch(/NODE_ENV === "production" && !process\.env\.AUTH_SECRET[\s\S]{0,200}throw new Error/);
  });

  it("proxy.ts (the edge session check) carries the identical guard", () => {
    const src = read("proxy.ts");
    expect(src).toMatch(/NODE_ENV === "production" && !process\.env\.AUTH_SECRET[\s\S]{0,200}throw new Error/);
  });

  it("the fallback string itself is unchanged (so the guard is the real fix, not a rename)", () => {
    expect(read("lib/auth.ts")).toMatch(/AUTH_SECRET \|\| "dev-secret"/);
    expect(read("proxy.ts")).toMatch(/AUTH_SECRET \|\| "dev-secret"/);
  });
});
