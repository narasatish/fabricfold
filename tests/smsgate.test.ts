/* SMS-Gate integration shape.

   Checked against the published OpenAPI spec rather than memory, because the
   original code had two faults that testing could not have caught without a
   physical phone — and one of them actively disguised itself. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const auth = read("lib/actions/auth.ts");

describe("the endpoint matches the spec", () => {
  it("posts to /messages, not /message", () => {
    /* The singular path returned 401, not 404, because auth runs before
       routing — so probing it looked like "alive, just needs credentials".
       Nothing would ever have been delivered. */
    expect(auth).toMatch(/api\.sms-gate\.app\/3rdparty\/v1\/messages"/);
    expect(auth).not.toMatch(/3rdparty\/v1\/message"/);
  });

  it("uses textMessage.text, not the deprecated `message` field", () => {
    const block = auth.slice(auth.indexOf("sgLogin && sgPass"));
    expect(block).toMatch(/textMessage: \{ text \}/);
    expect(block.slice(0, 1400)).not.toMatch(/body: JSON\.stringify\(\{ message: text/);
  });

  it("sends E.164 numbers", () => {
    expect(auth).toMatch(/phoneNumbers: \["\+91" \+ phone\]/);
  });

  it("authenticates with Basic, as the spec's ApiAuth requires", () => {
    // scoped to the fetch call, not a fixed character window — a longer
    // comment above it must not break the assertion
    const call = auth.slice(auth.indexOf("3rdparty/v1/messages"), auth.indexOf("3rdparty/v1/messages") + 700);
    expect(call).toMatch(/Authorization: "Basic " \+ Buffer\.from/);
  });
});

describe("failures are distinguishable", () => {
  it("names an offline phone separately from a generic failure", () => {
    // 503 means the gateway is fine and the handset is not — someone can fix that
    expect(auth).toMatch(/res\.status === 503/);
    expect(auth).toMatch(/SMS phone is offline/);
  });

  it("still logs the provider's own response for anything else", () => {
    expect(auth).toMatch(/console\.error\("SMS-Gate send failed", res\.status, detail\)/);
  });
});

describe("free provider is tried before any paid one", () => {
  it("SMS-Gate is checked ahead of Twilio", () => {
    // otherwise wiring Twilio for a test quietly starts billing every login
    const fn = auth.slice(auth.indexOf("async function sendSms"));
    expect(fn.indexOf("process.env.SMSGATE_LOGIN"))
      .toBeLessThan(fn.indexOf("process.env.TWILIO_ACCOUNT_SID"));
  });

  it("a dry run short-circuits before every provider", () => {
    /* Compare the CODE, not the first textual occurrence: the file header
       documents the env vars in a comment, so a naive indexOf found the
       documentation rather than the branch. */
    const fn = auth.slice(auth.indexOf("async function sendSms"));
    expect(fn.indexOf('process.env.SMS_DRY_RUN === "1"')).toBeGreaterThan(-1);
    expect(fn.indexOf('process.env.SMS_DRY_RUN === "1"'))
      .toBeLessThan(fn.indexOf("process.env.SMSGATE_LOGIN"));
  });
});

describe("the test script exists and fails loudly", () => {
  const s = read("scripts/test-smsgate.ts");
  it("checks a device is registered before blaming the send", () => {
    expect(s).toMatch(/\/devices/);
    expect(s).toMatch(/no device registered/);
  });
  it("follows the message to a final state rather than trusting the queue", () => {
    expect(s).toMatch(/FINAL = new Set\(\["Sent", "Delivered", "Failed", "Cancelled"\]\)/);
  });
  it("explains a Failed state in operational terms", () => {
    expect(s).toMatch(/SMS permission not granted/);
  });
});
