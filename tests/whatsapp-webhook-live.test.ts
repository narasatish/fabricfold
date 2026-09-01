/* The webhook, actually invoked.

   The sibling test reads the source; this one calls the handlers with real
   signatures. A public endpoint that will one day assert "this number is
   verified" deserves proof it rejects forgery, not a grep that says it should. */
import { beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";

const TOKEN = "verify-token-for-tests";
const SECRET = "app-secret-for-tests";

let GET: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;

beforeAll(async () => {
  process.env.WHATSAPP_VERIFY_TOKEN = TOKEN;
  process.env.WHATSAPP_APP_SECRET = SECRET;
  const mod = await import("../app/api/whatsapp/webhook/route");
  GET = mod.GET; POST = mod.POST;
});

const sign = (body: string, secret = SECRET) =>
  "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

const post = (body: string, sig?: string) =>
  POST(new Request("https://fabricfold.in/api/whatsapp/webhook", {
    method: "POST",
    headers: sig === undefined ? {} : { "x-hub-signature-256": sig },
    body,
  }));

const get = (qs: string) => GET(new Request(`https://fabricfold.in/api/whatsapp/webhook?${qs}`));

describe("handshake", () => {
  it("echoes the challenge for the right token", async () => {
    const res = await get(`hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=abc123`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc123"); // bare, not JSON-wrapped
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("refuses a wrong token", async () => {
    const res = await get("hub.mode=subscribe&hub.verify_token=wrong-token-x&hub.challenge=abc123");
    expect(res.status).toBe(403);
  });

  it("refuses a token of a different length without throwing", async () => {
    // timingSafeEqual throws on length mismatch — this must 403, not 500
    const res = await get("hub.mode=subscribe&hub.verify_token=short&hub.challenge=abc");
    expect(res.status).toBe(403);
  });

  it("refuses the right token with the wrong mode", async () => {
    const res = await get(`hub.mode=unsubscribe&hub.verify_token=${TOKEN}&hub.challenge=abc`);
    expect(res.status).toBe(403);
  });
});

describe("signature", () => {
  const body = JSON.stringify({ entry: [] });

  it("accepts a correctly signed body", async () => {
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
  });

  it("rejects a body signed with the wrong secret", async () => {
    const res = await post(body, sign(body, "attacker-secret"));
    expect(res.status).toBe(401);
  });

  it("rejects a tampered body under a valid old signature", async () => {
    // the exact attack: replay a real signature over forged content
    const sig = sign(body);
    const res = await post(JSON.stringify({ entry: [{ forged: true }] }), sig);
    expect(res.status).toBe(401);
  });

  it("rejects a missing header with 401, never 500", async () => {
    const res = await post(body);
    expect(res.status).toBe(401);
  });

  it("rejects a garbage header with 401, never 500", async () => {
    const res = await post(body, "not-even-a-signature");
    expect(res.status).toBe(401);
  });
});

describe("payloads", () => {
  const send = (payload: unknown) => { const b = JSON.stringify(payload); return post(b, sign(b)); };

  it("accepts a real inbound message shape", async () => {
    const res = await send({
      entry: [{ changes: [{ value: { messages: [{ from: "919876543210", type: "text", text: { body: "Verify me: K7M2Q9" } }] } }] }],
    });
    expect(res.status).toBe(200);
  });

  it("accepts a delivery receipt without treating it as a message", async () => {
    const res = await send({ entry: [{ changes: [{ value: { statuses: [{ status: "delivered" }] } }] }] });
    expect(res.status).toBe(200);
  });

  it("survives malformed JSON with 200, not 500", async () => {
    // a 500 here makes Meta retry, then disable the webhook
    const bad = "{not json";
    const res = await post(bad, sign(bad));
    expect(res.status).toBe(200);
  });

  it("survives an empty/unknown shape", async () => {
    const res = await send({});
    expect(res.status).toBe(200);
  });
});

describe("unconfigured", () => {
  it("rejects everything when the secret is absent — never accepts", async () => {
    const saved = process.env.WHATSAPP_APP_SECRET;
    delete process.env.WHATSAPP_APP_SECRET;
    const b = JSON.stringify({ entry: [] });
    const res = await post(b, sign(b, saved!));
    expect(res.status).toBe(503);
    process.env.WHATSAPP_APP_SECRET = saved;
  });
});
