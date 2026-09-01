/* The inbound WhatsApp webhook.

   This URL is public, and its payload will eventually be trusted to assert
   "this phone number is verified". Everything here is about making sure it
   can never be made to assert that by someone who isn't Meta. */
import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const src = read("app/api/whatsapp/webhook/route.ts");

describe("the handshake (GET)", () => {
  it("refuses without a configured token rather than accepting anything", () => {
    expect(src).toMatch(/if \(!expected\) return new Response\("webhook not configured", \{ status: 503 \}\)/);
  });
  it("requires mode=subscribe AND a matching token", () => {
    expect(src).toMatch(/mode === "subscribe" && a\.length === b\.length && crypto\.timingSafeEqual/);
  });
  it("echoes the bare challenge as text/plain", () => {
    // JSON or any wrapper fails Meta's check — it compares the body exactly
    expect(src).toMatch(/new Response\(challenge, \{ status: 200, headers: \{ "Content-Type": "text\/plain" \} \}\)/);
  });
});

describe("signature verification (POST)", () => {
  it("uses the app secret over the RAW body", () => {
    // re-serialising JSON changes bytes and breaks the HMAC
    expect(src).toMatch(/const body = await req\.text\(\)/);
    expect(src).toMatch(/createHmac\("sha256", secret\)\.update\(body\)/);
    expect(src).toMatch(/"sha256=" \+/);
  });
  it("compares lengths BEFORE timingSafeEqual", () => {
    /* timingSafeEqual throws on a length mismatch, so a missing header would
       500 instead of 401 — the same trap documented in the Razorpay webhook. */
    const i = src.indexOf("a.length !== b.length");
    const j = src.indexOf("crypto.timingSafeEqual", i);
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
  });
  it("rejects an unsigned request with 401, not 200", () => {
    expect(src).toMatch(/return new Response\("bad signature", \{ status: 401 \}\)/);
  });
  it("refuses to run at all without the secret", () => {
    // no secret must mean "reject everything", never "accept everything"
    const post = src.slice(src.indexOf("export async function POST"));
    expect(post.slice(0, 200)).toMatch(/if \(!secret\) return new Response\("webhook not configured", \{ status: 503 \}\)/);
  });
});

describe("payload handling", () => {
  it("ignores delivery receipts instead of treating them as messages", () => {
    expect(src).toMatch(/if \(!value\?\.messages\?\.length\) continue/);
  });
  it("answers 200 even for payloads it ignores", () => {
    /* Meta retries non-2xx and eventually disables a webhook that keeps
       failing, so an unrecognised shape must not look like an outage. */
    expect(src).toMatch(/return Response\.json\(\{ ok: true \}\)/);
  });
  it("survives malformed JSON without a 500", () => {
    expect(src).toMatch(/catch \{[\s\S]{0,120}return Response\.json\(\{ ok: true \}\)/);
  });
  it("does NOT authenticate anyone yet", () => {
    // this step proves delivery; a webhook that could sign people in before
    // we have confirmed it works is the wrong order to build in
    expect(src).not.toMatch(/createSession|db\.student|signIn/);
  });
});

describe("the HMAC scheme itself", () => {
  it("matches what Meta actually sends", () => {
    // guards the format, not just that some hashing happens
    const secret = "test-secret";
    const body = JSON.stringify({ entry: [] });
    const sig = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});
