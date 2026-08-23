/* The wall between the student and staff apps.

   Three layers, each pinned: the OTP gate (no code even SENT for a non-staff
   number), the session mode in the signed cookie, and the proxy that turns a
   student around before any /s code runs. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const auth = read("lib/actions/auth.ts");
const proxy = read("proxy.ts");

describe("layer 1 — the OTP gate", () => {
  it("checks the staff table BEFORE any send", () => {
    const fn = auth.slice(auth.indexOf("export async function requestOtp"));
    const gate = fn.indexOf('mode === "staff"');
    const send = fn.indexOf("sendSms(");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(send);
  });
  it("refuses deactivated staff with the SAME wording as never-registered", () => {
    // a rejected screen must not confirm which numbers were once staff
    expect(auth).toMatch(/!st \|\| !st\.active/);
  });
  it("re-checks at verify, not only at request", () => {
    const verify = auth.slice(auth.indexOf("export async function verifyOtp"));
    expect(verify).toMatch(/Not registered as staff/);
  });
});

describe("layer 3 — the proxy boundary", () => {
  it("exists as proxy.ts (Next 16 renamed middleware)", () => {
    expect(proxy).toMatch(/export async function proxy/);
  });
  it("matches both apps and ONLY the apps", () => {
    // /api in the matcher would add a JWT verify to every poll for nothing
    expect(proxy).toMatch(/matcher: \["\/s\/:path\*", "\/c\/:path\*"\]/);
  });
  it("sends a student on /s home, and staff on /c to their app", () => {
    expect(proxy).toMatch(/path\.startsWith\("\/s"\)[\s\S]{0,200}new URL\("\/c"/);
    expect(proxy).toMatch(/path\.startsWith\("\/c"\)[\s\S]{0,200}new URL\("\/s"/);
  });
  it("treats a bad signature as no session, not as an error page", () => {
    expect(proxy).toMatch(/catch \{\s*\n\s*return null/);
  });
  it("verifies the signature — it never trusts a decoded payload", () => {
    expect(proxy).toMatch(/jwtVerify/);
    expect(proxy).not.toMatch(/decodeJwt/);
  });
  it("does NOT query the database at the edge", () => {
    // role/active/epoch are re-verified in requireStaff on every action anyway
    expect(proxy).not.toMatch(/from "\.\/lib\/db"|prisma|db\./);
  });
});

describe("WhatsApp OTP channel", () => {
  it("is tried before every SMS provider", () => {
    const fn = auth.slice(auth.indexOf("async function sendSms"));
    const wa = fn.indexOf("waOtpConfigured()");
    const sg = fn.indexOf("SMSGATE_LOGIN");
    expect(wa).toBeGreaterThan(-1);
    expect(wa).toBeLessThan(sg);
  });
  it("falls back to SMS instead of erroring when the send fails", () => {
    // commonest failure: the student has no WhatsApp — they still need a code
    expect(auth).toMatch(/falling back to SMS/);
  });
  it("uses an AUTHENTICATION template, never free-form text with a code", () => {
    // Meta rejects free-form OTPs outside the 24h window — which a login always is
    expect(auth).toMatch(/type: "template"/);
    expect(auth).toMatch(/WHATSAPP_OTP_TEMPLATE/);
    expect(auth).toMatch(/sub_type: "url"/); // the copy-code button Meta requires
  });
  it("counts as a deliverable channel, so the OTP gate opens with it alone", () => {
    const cfg = auth.slice(auth.indexOf("function smsConfigured"), auth.indexOf("function testPhones"));
    expect(cfg).toMatch(/WHATSAPP_OTP_TEMPLATE/);
  });
  it("dry-run still short-circuits before it", () => {
    const fn = auth.slice(auth.indexOf("async function sendSms"));
    expect(fn.indexOf("SMS_DRY_RUN")).toBeLessThan(fn.indexOf("waOtpConfigured()"));
  });
});
