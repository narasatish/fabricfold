/* Found 2026-10-22: error-digest's own route comment said "mark seen only
   AFTER the mail is away, so a send failure means the next run reports
   them again rather than losing them silently" — but sendMail/notifyOwner
   never actually told the caller whether the send worked. A non-OK Resend
   response only hit console.error, which nobody reads on a serverless
   host, so the route always treated the digest as delivered and marked
   every ErrorLog row seen regardless. This test proves the real behavior:
   a failed email send (with no owner push subscription either) must leave
   the errors unseen so the next run retries; a successful send must mark
   them seen exactly once. */
import "dotenv/config";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../lib/db";

const COLLEGE_ID = "errdigest-college";

beforeAll(async () => {
  await db.college.upsert({
    where: { id: COLLEGE_ID },
    create: { id: COLLEGE_ID, name: "Error Digest College", address: "x", features: {} },
    update: {},
  });
});

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

beforeEach(async () => {
  process.env.RESEND_API_KEY = "test-resend-key";
  process.env.OWNER_EMAIL = "owner@example.test";
  process.env.CRON_SECRET = "test-digest-secret";
  await db.errorLog.deleteMany({ where: { message: { startsWith: "ERRDIGEST-TEST" } } });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.RESEND_API_KEY;
  delete process.env.OWNER_EMAIL;
  if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  await db.errorLog.deleteMany({ where: { message: { startsWith: "ERRDIGEST-TEST" } } });
});

describe("error-digest only marks errors seen when delivery actually succeeds", () => {
  it("a failed mail send (and no push subscriptions) leaves the errors unseen", async () => {
    const e = await db.errorLog.create({ data: { kind: "server", message: "ERRDIGEST-TEST failure case", seen: false } });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));

    const { GET } = await import("../app/api/cron/error-digest/route");
    const req = new Request("https://x.test/api/cron/error-digest", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
    const res = await GET(req);
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.sent).toBe(false);

    const after = await db.errorLog.findUniqueOrThrow({ where: { id: e.id } });
    expect(after.seen).toBe(false);
  });

  it("a successful mail send marks the errors seen", async () => {
    const e = await db.errorLog.create({ data: { kind: "server", message: "ERRDIGEST-TEST success case", seen: false } });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const { GET } = await import("../app/api/cron/error-digest/route");
    const req = new Request("https://x.test/api/cron/error-digest", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
    const res = await GET(req);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.sent).toBe(true);

    const after = await db.errorLog.findUniqueOrThrow({ where: { id: e.id } });
    expect(after.seen).toBe(true);
  });
});
