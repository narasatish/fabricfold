/* Full behavioral test for "Continue with WhatsApp" (lib/actions/wa-login.ts
   + app/api/whatsapp/webhook/route.ts), run against a live Postgres test
   schema and the REAL webhook route handler (constructed Request, genuine
   HMAC-SHA256 signature) — not just code review. Exercises the whole round
   trip: startWhatsAppLogin sets a claim cookie and returns a code -> a
   signed webhook delivery (as Meta would send it) matches the code to an
   account -> checkWhatsAppLogin, holding the original claim cookie, mints
   a session. Also covers the security properties this flow depends on:
   wrong-device (claim cookie missing/mismatched), bad webhook signature,
   an unregistered phone, and Meta's own retry (duplicate delivery) not
   double-processing. */
import "dotenv/config";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";

process.env.WHATSAPP_BUSINESS_NUMBER = "919999900000";
process.env.WHATSAPP_APP_SECRET = "test-wa-app-secret";

let cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.220" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const SCHEMA = "ff_wa_login_flow";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let waLogin: typeof import("../lib/actions/wa-login");
let webhook: typeof import("../app/api/whatsapp/webhook/route");

beforeAll(async () => {
  if (!IS_PG) throw new Error("This test needs a real Postgres DATABASE_URL/DIRECT_URL.");
  const { Client } = await import("pg");
  const client = new Client({ connectionString: BASE.split("?")[0] });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await client.end();
  execSync("npx prisma db push", {
    cwd: path.resolve(__dirname, ".."), stdio: "ignore",
    env: { ...process.env, DATABASE_URL: TEST_URL },
  });
  db = (await import("../lib/db")).db;
  waLogin = await import("../lib/actions/wa-login");
  webhook = await import("../app/api/whatsapp/webhook/route");

  await db.college.create({ data: { id: "col1", name: "Test College", features: {} } });
  await db.student.create({ data: { id: "777777", phone: "9999900007", name: "WA Student", collegeId: "col1" } });
  await db.staff.create({ data: { id: "staff777", phone: "9999900077", name: "WA Staff", role: 2, collegeId: "col1" } });
}, 300_000);

function signedWebhookRequest(body: object) {
  const text = JSON.stringify(body);
  const sig = "sha256=" + crypto.createHmac("sha256", process.env.WHATSAPP_APP_SECRET!).update(text).digest("hex");
  return new Request("http://localhost/api/whatsapp/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": sig, "content-type": "application/json" },
    body: text,
  });
}

function inboundMessage(from: string, text: string) {
  return { entry: [{ changes: [{ value: { messages: [{ from, type: "text", text: { body: text } }] } }] }] };
}

describe("the full customer WhatsApp sign-in round trip", () => {
  it("start -> signed webhook delivery -> poll claims a real session, using the original browser's cookie", async () => {
    cookieJar = new Map();
    const start = await waLogin.startWhatsAppLogin("customer");
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(start.link).toContain(start.code);

    const res = await webhook.POST(signedWebhookRequest(inboundMessage("919999900007", `Sign me in to FabricFold: ${start.code}`)));
    expect(res.status).toBe(200);

    const poll = await waLogin.checkWhatsAppLogin(start.code);
    expect(poll).toEqual({ ok: true, status: "signed-in", staff: false });

    const row = await db.waVerify.findUnique({ where: { code: start.code } });
    expect(row?.status).toBe("claimed");
  });

  it("a second poll on an already-claimed code is rejected, not re-signed-in", async () => {
    cookieJar = new Map();
    const start = await waLogin.startWhatsAppLogin("customer");
    if (!start.ok) throw new Error("start failed");
    await webhook.POST(signedWebhookRequest(inboundMessage("919999900007", start.code)));
    const first = await waLogin.checkWhatsAppLogin(start.code);
    expect(first.ok).toBe(true);
    const second = await waLogin.checkWhatsAppLogin(start.code);
    expect(second).toEqual({ ok: false, status: "claimed", error: "That sign-in was already used — start again." });
  });

  it("polling from a different browser (no/wrong claim cookie) is refused even though the code verified", async () => {
    cookieJar = new Map();
    const start = await waLogin.startWhatsAppLogin("customer");
    if (!start.ok) throw new Error("start failed");
    await webhook.POST(signedWebhookRequest(inboundMessage("919999900007", start.code)));

    cookieJar = new Map(); // simulate polling from a browser that never held the claim cookie
    const poll = await waLogin.checkWhatsAppLogin(start.code);
    expect(poll.ok).toBe(false);
    expect(poll.status).toBe("wrong-device");
  });

  it("an unregistered phone number fails with a clear reason instead of hanging pending forever", async () => {
    cookieJar = new Map();
    const start = await waLogin.startWhatsAppLogin("customer");
    if (!start.ok) throw new Error("start failed");
    await webhook.POST(signedWebhookRequest(inboundMessage("919999900099", start.code)));
    const poll = await waLogin.checkWhatsAppLogin(start.code);
    expect(poll.ok).toBe(false);
    expect(poll.status).toBe("failed");
  });

  it("a duplicate webhook delivery (Meta's own retry) does not double-resolve an already-verified row", async () => {
    cookieJar = new Map();
    const start = await waLogin.startWhatsAppLogin("customer");
    if (!start.ok) throw new Error("start failed");
    const req1 = signedWebhookRequest(inboundMessage("919999900007", start.code));
    const req2 = signedWebhookRequest(inboundMessage("919999900007", start.code));
    const [r1, r2] = await Promise.all([webhook.POST(req1), webhook.POST(req2)]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const poll = await waLogin.checkWhatsAppLogin(start.code);
    expect(poll).toEqual({ ok: true, status: "signed-in", staff: false });
  });

  it("a badly signed webhook delivery is rejected with 401, never reaching the matching logic", async () => {
    const text = JSON.stringify(inboundMessage("919999900007", "whatever"));
    const req = new Request("http://localhost/api/whatsapp/webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=deadbeef", "content-type": "application/json" },
      body: text,
    });
    const res = await webhook.POST(req);
    expect(res.status).toBe(401);
  });
});

describe("the full staff WhatsApp sign-in round trip", () => {
  it("a registered staff number signs in as staff, not customer", async () => {
    cookieJar = new Map();
    const start = await waLogin.startWhatsAppLogin("staff");
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    await webhook.POST(signedWebhookRequest(inboundMessage("919999900077", start.code)));
    const poll = await waLogin.checkWhatsAppLogin(start.code);
    expect(poll).toEqual({ ok: true, status: "signed-in", staff: true });
  });

  it("a student's number cannot ride a staff sign-in attempt", async () => {
    cookieJar = new Map();
    const start = await waLogin.startWhatsAppLogin("staff");
    if (!start.ok) throw new Error("start failed");
    await webhook.POST(signedWebhookRequest(inboundMessage("919999900007", start.code)));
    const poll = await waLogin.checkWhatsAppLogin(start.code);
    expect(poll.ok).toBe(false);
    expect(poll.status).toBe("failed");
  });
});
