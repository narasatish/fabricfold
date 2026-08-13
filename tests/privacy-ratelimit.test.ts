/* Rate limiting and privacy guarantees.

   Both touch things that are hard to undo — an over-eager limiter locks real
   students out, and erasure is irreversible — so the rules are pinned here. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { clientIp } from "../lib/rate-limit";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");

describe("client IP extraction", () => {
  it("takes the first hop from x-forwarded-for", () => {
    // the chain is client, proxy1, proxy2 — only the first is the caller
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1, 10.0.0.2" }))).toBe("1.2.3.4");
  });
  it("falls back to x-real-ip", () => {
    expect(clientIp(new Headers({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
  });
  it("reports unknown rather than guessing", () => {
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("rate limiter", () => {
  const src = read("lib/rate-limit.ts");

  it("stores state in the database, not memory", () => {
    // serverless instances share no memory: an in-process counter is no limit
    expect(src).toMatch(/db\.rateLimit/);
  });

  it("FAILS OPEN if the limiter itself breaks", () => {
    // being unable to log in because the limiter is unhappy is worse than the
    // abuse it prevents
    expect(src).toMatch(/allowed: true, remaining: max, retryAfterSec: 0/);
    expect(src).toMatch(/failed open/i);
  });

  it("tells the caller how long to wait", () => {
    expect(src).toMatch(/retryAfterSec/);
  });

  it("can prune old windows so the table cannot grow forever", () => {
    expect(src).toMatch(/pruneRateLimits/);
  });
});

describe("OTP request limits", () => {
  const src = read("lib/actions/auth.ts");

  it("caps per number AND per IP", () => {
    // per-number alone still lets someone cycle numbers and bill us for
    // hundreds of texts sent to strangers
    expect(src).toMatch(/otp:phone:/);
    expect(src).toMatch(/otp:ip:/);
  });

  it("skips the IP cap when the IP is unknown rather than blocking everyone", () => {
    expect(src).toMatch(/ip !== "unknown"/);
  });
});

describe("data export", () => {
  const src = read("lib/actions/privacy.ts");

  it("never exports the passcode or its hash", () => {
    expect(src).toMatch(/hasPasscode: !!stu\.passwordHash/);
    expect(src).not.toMatch(/passwordHash: stu\.passwordHash/);
    expect(src).not.toMatch(/passwordSalt: stu\.passwordSalt/);
  });

  it("normalises Decimal and Date so amounts don't export as empty objects", () => {
    expect(src).toMatch(/JSON\.parse\(JSON\.stringify\(/);
  });
});

describe("erasure", () => {
  const src = read("lib/actions/privacy.ts");

  it("anonymises rather than deleting, and says why", () => {
    // financial rows are immutable by trigger and retained for tax; promising
    // deletion would be a lie told to someone exercising a legal right
    expect(src).toMatch(/ANONYMISATION/);
    expect(src).not.toMatch(/student\.delete\(/);
    expect(src).not.toMatch(/payment\.delete/);
  });

  it("gives the phone a non-colliding placeholder, not null", () => {
    // phone is UNIQUE — null would break the index on a second erasure
    expect(src).toMatch(/phone: `deleted-\$\{id\}`/);
  });

  it("clears the passcode and kills live sessions", () => {
    expect(src).toMatch(/passwordHash: null/);
    expect(src).toMatch(/sessionEpoch: \{ increment: 1 \}/);
  });

  it("requires explicit confirmation from the student", () => {
    expect(src).toMatch(/!== "DELETE"/);
  });

  it("staff erasure is Admin+ and demands a reason", () => {
    expect(src).toMatch(/requireStaff\(3\)/);
    expect(src).toMatch(/Give a reason/);
  });

  it("is audited both ways", () => {
    expect(src).toMatch(/audit\("Data erased \(student request\)"/);
    expect(src).toMatch(/audit\("Data erased \(staff\)"/);
  });
});

describe("error alerting", () => {
  const src = read("app/api/cron/error-digest/route.ts");

  it("groups by message so one recurring fault isn't 200 emails", () => {
    expect(src).toMatch(/groups\.set|groups\.get/);
  });

  it("marks errors seen only AFTER the mail is away", () => {
    // otherwise a send failure loses them silently
    const mailAt = src.indexOf("notifyOwner");
    const markAt = src.indexOf("updateMany");
    expect(mailAt).toBeGreaterThan(-1);
    expect(markAt).toBeGreaterThan(mailAt);
  });

  it("is Owner-only or cron-authenticated", () => {
    expect(src).toMatch(/CRON_SECRET/);
    expect(src).toMatch(/st\.role >= 4/);
  });
});
