/* Real function calls (not source-regex) for the shared cron-secret check.
   Consolidated 2026-09-05 from six near-identical, plain-string-comparison
   copies (one per cron/backup/report route) into one timing-safe helper —
   this codebase's webhook routes (Razorpay, WhatsApp) already used
   crypto.timingSafeEqual for the same kind of Bearer-token check; the cron
   routes never got the same treatment until now. */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { isCronRequest } from "../lib/cron-auth";

const ORIGINAL = process.env.CRON_SECRET;

describe("isCronRequest", () => {
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = ORIGINAL;
  });

  it("accepts the exact Bearer token", () => {
    process.env.CRON_SECRET = "test-secret-value-123";
    const req = new Request("https://x.test", { headers: { authorization: "Bearer test-secret-value-123" } });
    expect(isCronRequest(req)).toBe(true);
  });

  it("refuses a wrong secret", () => {
    process.env.CRON_SECRET = "test-secret-value-123";
    const req = new Request("https://x.test", { headers: { authorization: "Bearer wrong-secret" } });
    expect(isCronRequest(req)).toBe(false);
  });

  it("refuses a missing Authorization header, without throwing", () => {
    process.env.CRON_SECRET = "test-secret-value-123";
    const req = new Request("https://x.test");
    expect(isCronRequest(req)).toBe(false);
  });

  it("refuses a header shorter or longer than the expected value, without throwing", () => {
    // timingSafeEqual throws on a length mismatch — this must be handled
    // internally, the same trap every other timing-safe check in this
    // codebase documents guarding against.
    process.env.CRON_SECRET = "test-secret-value-123";
    expect(isCronRequest(new Request("https://x.test", { headers: { authorization: "Bearer x" } }))).toBe(false);
    expect(isCronRequest(new Request("https://x.test", { headers: { authorization: "Bearer " + "x".repeat(500) } }))).toBe(false);
  });

  it("refuses everything when CRON_SECRET isn't configured, even a request with no header at all", () => {
    delete process.env.CRON_SECRET;
    expect(isCronRequest(new Request("https://x.test"))).toBe(false);
    expect(isCronRequest(new Request("https://x.test", { headers: { authorization: "Bearer undefined" } }))).toBe(false);
  });
});
