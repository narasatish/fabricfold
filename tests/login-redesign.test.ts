/* Login redesign (owner, Sep 2026): WhatsApp is the hero, Staff is a corner
   link, and no visitor is ever shown a phone field that leads to a dead
   OTP screen — OTP is fully broken for staff (no SMS provider) and for any
   first-time customer (no passcode yet), so offering it as the FIRST thing
   on the page was the actual bug. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const form = read("app/login/_components/LoginForm.tsx");

describe("WhatsApp is the hero, not an alternative below a phone field", () => {
  it("the hero step shows NO phone input by default", () => {
    const hero = form.slice(form.indexOf('step === "hero"'), form.indexOf('step === "whatsapp"'));
    // the field only appears inside the showPhone toggle, never unconditionally
    expect(hero).toMatch(/!showPhone \? \(/);
    expect(hero).toMatch(/Have a passcode\? Sign in with your number/);
  });
  it("a number with no passcode is sent back to WhatsApp, never into a dead OTP screen", () => {
    expect(form).toMatch(/setShowPhone\(false\);\s*\n\s*toast\("No passcode set for this number yet — tap Continue with WhatsApp", true\);/);
    // and — the actual fix — it does NOT fall through to handleRequestOtp
    const fn = form.slice(form.indexOf("const handleContinue"), form.indexOf("const handlePasscodeLogin"));
    expect(fn).not.toMatch(/handleRequestOtp/);
  });
});

describe("Staff is a quiet corner link, not a competing tab", () => {
  it("no big segmented Customer/Staff control remains", () => {
    expect(form).not.toMatch(/Sign in as:/);
    expect(form).not.toMatch(/className="seg"/);
  });
  it("the corner link toggles mode and is NOT styled as a flex-filling spacer", () => {
    expect(form).toMatch(/Staff sign-in/);
    expect(form).not.toMatch(/className="spacer"/); // that bug: flex:1 on a text button centers it, doesn't push it right
    expect(form).toMatch(/marginLeft: "auto"/);
  });
  it("staff mode shows WhatsApp only — no phone field, no OTP, matching that SMS isn't configured", () => {
    const staffBranch = form.slice(form.indexOf("Staff: WhatsApp only"), form.indexOf("{/* A QR scan"));
    expect(staffBranch).toMatch(/Continue with WhatsApp/);
    expect(staffBranch).not.toMatch(/type="tel"|hasPasscode|requestOtp/);
  });
});

describe("the images are the compressed, right-sized variants", () => {
  it("login uses the 264px asset (2x retina for a 132px display), not the 512px original", () => {
    expect(form).toMatch(/src="\/logo-full-264\.png"/);
    expect(form).not.toMatch(/src="\/logo-full\.png"/);
  });
  it("the compressed asset is meaningfully smaller than the original", () => {
    const orig = fs.statSync(path.resolve(__dirname, "..", "public/logo-full.png")).size;
    const compressed = fs.statSync(path.resolve(__dirname, "..", "public/logo-full-264.png")).size;
    expect(compressed).toBeLessThan(orig * 0.6); // real win, not a rounding difference
  });
  it("/get uses the matching 192px variant (2x for its 96px display)", () => {
    const get = read("app/get/page.tsx");
    expect(get).toMatch(/src="\/logo-full-192\.png"/);
  });
});

describe("nothing genuinely useful was removed", () => {
  it("forgot-passcode still reaches OTP — a locked-out student is never fully stuck", () => {
    expect(form).toMatch(/Forgot passcode — sign in with OTP/);
    expect(form).toMatch(/handleRequestOtp\(\)/);
  });
  it("the not-registered message still points to the counter", () => {
    expect(form).toMatch(/Please visit your campus counter/);
  });
  it("the WhatsApp waiting screen still shows the fallback code and a way back", () => {
    expect(form).toMatch(/Your code/);
    expect(form).toMatch(/setStep\("hero"\)/);
  });
});
