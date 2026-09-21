/* Found in the Sep 21 QA pass, reading the public front doors: WhatsApp sign-in
   and BVRIT self-registration were capped at 10 attempts per hour PER IP. A whole
   campus sits behind one shared WiFi/NAT address, so on launch morning the 11th
   student in an hour was told "Too many attempts". The code is 8 characters, lives
   5 minutes and is bound to the browser that started it, so these caps protect
   little beyond table spam; they are raised to campus scale. Registration also
   had no name length limit (the name goes straight onto the student). */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (f: string) => fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");
const num = (src: string, name: string) => Number(new RegExp(`const ${name} = ([0-9]+)`).exec(src)?.[1]);

describe("launch-day rate limits are sized for a shared campus WiFi", () => {
  it("WhatsApp sign-in allows at least 100 attempts/hour/IP", () => {
    const src = read("lib/actions/wa-login.ts");
    expect(num(src, "WA_START_MAX_PER_IP_HOUR")).toBeGreaterThanOrEqual(100);
    expect(src).toMatch(/rateLimit\(`wa:start:\$\{ip\}`, WA_START_MAX_PER_IP_HOUR, 3600\)/);
  });
  it("BVRIT registration allows at least 60 attempts/hour/IP", () => {
    const src = read("lib/actions/wa-register.ts");
    expect(num(src, "WA_REGISTER_MAX_PER_IP_HOUR")).toBeGreaterThanOrEqual(60);
    expect(src).toMatch(/rateLimit\(`wa:register:\$\{ip\}`, WA_REGISTER_MAX_PER_IP_HOUR, 3600\)/);
  });
  it("the passcode per-IP cap is deliberately left at 20: it stops one address spraying guesses across accounts, and passcode logins are rare", () => {
    expect(num(read("lib/actions/auth.ts"), "PASSCODE_MAX_PER_IP_HOUR")).toBe(20);
  });
});

describe("registration name", () => {
  const src = read("lib/actions/wa-register.ts");
  it("is capped at 80 characters and stripped of control characters before it is stored", () => {
    const fn = src.slice(src.indexOf("export async function startWhatsAppRegister"), src.indexOf("export async function checkWhatsAppRegister"));
    expect(fn).toMatch(/name\.length > 80/);
    expect(fn).toContain("u0000-" + String.fromCharCode(92) + "u001f");
    expect(fn.indexOf("name.length > 80")).toBeLessThan(fn.indexOf("waVerify.create"));
  });
});
