/* Found in the Sep 21 QA pass: /api/push/subscribe stored ANY string as a push
   endpoint (an http:// internal address was accepted, so was a 20KB URL), and the
   server later POSTs notifications to that URL - a logged-in student could aim
   the server at internal addresses (blind SSRF). Garbage JSON also crashed the
   route with a 500. Endpoints must be https on a real browser push service. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isPushEndpoint } from "../lib/push-validation";

describe("isPushEndpoint", () => {
  it("accepts the real browser push services", () => {
    for (const u of [
      "https://fcm.googleapis.com/fcm/send/abc123",
      "https://android.googleapis.com/gcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://web.push.apple.com/QGxyz",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
      "https://fcm.googleapis.com/wp/xyz",
    ]) expect(isPushEndpoint(u), u).toBe(true);
  });
  it("rejects non-https, internal, look-alike and malformed URLs", () => {
    for (const u of [
      "http://fcm.googleapis.com/fcm/send/abc", "https://169.254.169.254/latest/meta-data", "http://localhost:3000/x",
      "https://internal.render.com/x", "https://evil.com/fcm.googleapis.com", "https://fcm.googleapis.com.evil.com/x",
      "https://fcm.googleapis.com@evil.com/x", "https://evilfcm.googleapis.com.evil.com", "https://notgoogleapis.com/x",
      "https://fcm.googleapis.com:8080/x", "ftp://fcm.googleapis.com/x", "javascript:alert(1)", "not a url", "",
      "https://fcm.googleapis.com/" + "a".repeat(2000),
    ]) expect(isPushEndpoint(u), u.slice(0, 60)).toBe(false);
    for (const bad of [null, undefined, 5, {}, []]) expect(isPushEndpoint(bad as never)).toBe(false);
  });
});

describe("the subscribe route uses it and survives bad JSON", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "app/api/push/subscribe/route.ts"), "utf8");
  it("validates the endpoint before storing", () => {
    expect(src).toMatch(/isPushEndpoint\(/);
    expect(src.indexOf("isPushEndpoint(")).toBeLessThan(src.indexOf("upsert"));
  });
  it("parses JSON inside a try/catch and returns 400", () => {
    expect(src).toMatch(/try \{[^}]*req\.json\(\)/);
  });
  it("caps the key lengths", () => {
    expect(src).toMatch(/p256dh[sS]*length/);
  });
});
