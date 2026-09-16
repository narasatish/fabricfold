/* Behavioral test for the new fast watchdog route (app/api/cron/watchdog/route.ts,
   2026-09-16): unlike the daily error-digest, this one is meant to catch a
   real server error and alert the Owner within minutes, not wait for the
   6am rollup. Proves: unauthenticated requests are refused, an unseen
   "server" error triggers an alert and gets marked seen, a "client" error
   is deliberately ignored (browser noise, not a signal the app is broken),
   and a second run with nothing new sends nothing. */
import "dotenv/config";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_watchdog";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;
process.env.CRON_SECRET = "test-cron-secret";

let db: typeof import("../lib/db").db;
let GET: (req: Request) => Promise<Response>;
const sentMail: { to: string; subject: string; text: string }[] = [];

beforeAll(async () => {
  const { Client } = await import("pg");
  const admin = new Client({ connectionString: BASE.split("?")[0] });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await admin.end();
  execSync("npx prisma db push", {
    cwd: path.resolve(__dirname, ".."), stdio: "ignore",
    env: { ...process.env, DATABASE_URL: TEST_URL },
  });

  db = (await import("../lib/db")).db;
  // notifyOwner needs an owner email to actually send — lib/mail.ts's
  // ownerEmail() checks this env var first, before ever touching AppConfig.
  process.env.OWNER_EMAIL = "owner@test.fabricfold.in";

  // Capture outgoing mail instead of hitting Resend — no RESEND_API_KEY set,
  // so lib/mail.ts's sendMail() logs to console; intercept notifyOwner's
  // call chain at the fetch boundary would need a real key, so instead spy
  // on console.log (sendMail's own no-key fallback path) to capture what
  // WOULD have been sent, without needing network access in a test.
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.join(" ");
    const m = line.match(/^\[MAIL -> (.+?)\] (.+)\n([\s\S]*)$/);
    if (m) sentMail.push({ to: m[1], subject: m[2], text: m[3] });
    orig(...args);
  };

  const mod = await import("../app/api/cron/watchdog/route");
  GET = mod.GET;
}, 300_000);

const req = (auth?: string) =>
  GET(new Request("https://fabricfold.in/api/cron/watchdog", {
    headers: auth ? { authorization: auth } : {},
  }));

describe("watchdog auth", () => {
  it("refuses a request with no CRON_SECRET bearer token", async () => {
    const res = await req();
    expect(res.status).toBe(401);
  });
  it("refuses the wrong secret", async () => {
    const res = await req("Bearer wrong-secret");
    expect(res.status).toBe(401);
  });
});

describe("watchdog alerting", () => {
  it("does nothing when there are no unseen server errors", async () => {
    sentMail.length = 0;
    const res = await req("Bearer test-cron-secret");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, errors: 0, sent: false });
    expect(sentMail.length).toBe(0);
  });

  it("alerts on an unseen SERVER error and marks it seen", async () => {
    await db.errorLog.create({ data: { kind: "server", message: "TypeError: cannot read x of undefined", url: "/s/orders/123" } });
    sentMail.length = 0;
    const res = await req("Bearer test-cron-secret");
    const body = await res.json();
    expect(body.sent).toBe(true);
    expect(body.errors).toBe(1);
    expect(sentMail.length).toBe(1);
    expect(sentMail[0].subject).toMatch(/live server error/);

    const rows = await db.errorLog.findMany({ where: { kind: "server" } });
    expect(rows.every((r) => r.seen)).toBe(true);
  });

  it("ignores a CLIENT error — that's browser noise, not proof the app is broken", async () => {
    await db.errorLog.create({ data: { kind: "client", message: "ResizeObserver loop limit exceeded" } });
    sentMail.length = 0;
    const res = await req("Bearer test-cron-secret");
    const body = await res.json();
    expect(body.sent).toBe(false);
    expect(sentMail.length).toBe(0);
  });

  it("a second run with nothing new sends nothing (already-seen rows stay quiet)", async () => {
    sentMail.length = 0;
    const res = await req("Bearer test-cron-secret");
    const body = await res.json();
    expect(body.sent).toBe(false);
    expect(sentMail.length).toBe(0);
  });
});
