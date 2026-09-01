/* "Continue with WhatsApp" — sign-in by inbound message.

   The threat this design exists to survive: the code travels through WhatsApp
   in clear text and is printed on screen, so anyone standing behind the
   student can read it. Reading it must not be enough to take the session. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const act = read("lib/actions/wa-login.ts");
const hook = read("app/api/whatsapp/webhook/route.ts");
const ui = read("app/login/_components/LoginForm.tsx");
const schema = read("prisma/schema.prisma");

describe("the code alone cannot sign anyone in", () => {
  it("requires a claim secret held only in this browser", () => {
    expect(act).toMatch(/httpOnly: true/);
    expect(act).toMatch(/wrong-device/);
  });
  it("stores the claim secret HASHED, so a DB leak can't claim sign-ins", () => {
    expect(act).toMatch(/claimHash: sha\(claimSecret\)/);
    expect(act).not.toMatch(/claimSecret: claimSecret/);
  });
  it("compares the claim in constant time, length-checked first", () => {
    const i = act.indexOf("a.length !== b.length");
    const j = act.indexOf("crypto.timingSafeEqual", i);
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
  });
  it("the webhook never creates a session — it only records", () => {
    // it knows WHO sent the message but not WHICH browser is waiting
    expect(hook).not.toMatch(/createSession/);
    expect(act).toMatch(/createSession\(\{ mode: "customer"/);
  });
});

describe("the code itself", () => {
  it("is crypto-random, never Math.random", () => {
    expect(act).toMatch(/crypto\.randomBytes\(8\)/);
    expect(act).not.toMatch(/Math\.random/);
  });
  it("avoids characters that get misread when retyped", () => {
    // no O/0, I/1, S/5 — this appears on screen and may be typed by hand
    const m = act.match(/const ALPHABET = "([^"]+)"/);
    expect(m).toBeTruthy();
    for (const ch of "OI0S15") expect(m![1]).not.toContain(ch);
  });
  it("is matched case-insensitively out of a sentence the student may edit", () => {
    expect(hook).toMatch(/text\.toUpperCase\(\)\.match\(/);
  });
});

describe("single use and expiry", () => {
  it("expires in five minutes, like the OTP it replaces", () => {
    expect(act).toMatch(/const TTL_MS = 5 \* 60_000/);
  });
  it("claims atomically, so two polls can't both mint a session", () => {
    expect(act).toMatch(/updateMany\(\{[\s\S]{0,120}status: "verified"[\s\S]{0,80}status: "claimed"/);
    expect(act).toMatch(/won\.count !== 1/);
  });
  it("a duplicate webhook delivery cannot overwrite a resolved row", () => {
    // Meta retries; the status filter must stay in the WHERE
    expect(hook).toMatch(/updateMany\(\{\s*\n\s*where: \{ id: row\.id, status: "pending" \}/);
  });
  it("refuses an expired attempt rather than signing in late", () => {
    expect(act).toMatch(/row\.expiresAt\.getTime\(\) < Date\.now\(\)/);
  });
});

describe("unregistered numbers", () => {
  it("fail with the counter message, not silence", () => {
    /* The student is watching a spinner. Silence would leave it spinning
       until expiry with no idea why — same wording as OTP sign-in. */
    expect(hook).toMatch(/status: "failed"/);
    expect(hook).toContain("visit the counter to be registered");
  });
  it("normalises the number the same way as everywhere else", () => {
    expect(hook).toMatch(/from\.replace\([^)]+\)\.slice\(-10\)/);
  });
});

describe("abuse limits", () => {
  it("caps attempts per IP — each one is a row and a live code", () => {
    expect(act).toMatch(/rateLimit\(`wa:start:\$\{ip\}`/);
  });
  it("refuses cleanly when the business number isn't configured", () => {
    expect(act).toMatch(/isn't switched on yet/);
  });
});

describe("the login screen", () => {
  it("offers it to customers only, never staff", () => {
    // a staff account takes payments; it keeps the harder door
    expect(ui).toMatch(/mode === "customer" && \(\s*\n\s*<>/);
    expect(ui).toMatch(/Continue with WhatsApp/);
  });
  it("opens WhatsApp in the same tick as the tap", () => {
    // a popup opened from an async callback is blocked on iOS Safari
    const fn = ui.slice(ui.indexOf("const handleWhatsApp"));
    expect(fn.indexOf("window.open")).toBeLessThan(fn.indexOf("setWaCode"));
  });
  it("shows the code, in case WhatsApp never opened", () => {
    expect(ui).toMatch(/Your code/);
  });
  it("always offers a way back to the number flow", () => {
    expect(ui).toMatch(/Use my number instead/);
  });
  it("stops polling when the component unmounts", () => {
    expect(ui).toMatch(/return stop;/);
  });
});

describe("schema", () => {
  it("the code is unique, so a collision can't cross two sign-ins", () => {
    const m = schema.slice(schema.indexOf("model WaVerify"));
    expect(m).toMatch(/code\s+String\s+@unique/);
  });
});
