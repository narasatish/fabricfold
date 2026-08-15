/* Live Google Sheet log.

   The failure this guards against is silent: rows that never arrive, or arrive
   for orders that were rolled back. Neither shows up as an error at the
   counter, so the rules are pinned here. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { istStamp, MAX_ATTEMPTS } from "../lib/sheet-events";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const events = read("lib/sheet-events.ts");
const orders = read("lib/actions/orders.ts");

describe("the outbox never costs an order", () => {
  it("enqueue swallows its own failure", () => {
    // a Sheet is a report; failing to write one must not roll back a real order
    expect(events).toMatch(/catch \(e\) \{\s*console\.error\("\[sheets\] enqueue failed:/);
  });

  it("appendSheet returns a result instead of throwing", () => {
    const sheets = read("lib/sheets.ts");
    const fn = sheets.slice(sheets.indexOf("export async function appendSheet"));
    expect(fn).toMatch(/catch \(e\) \{\s*return \{ ok: false as const/);
  });

  it("the fast path is fire-and-forget, never awaited", () => {
    expect(events).toMatch(/export function flushSoon\(\) \{\s*void flushSheetOutbox\(\)/);
    // callers must not await it — that would put Google back on the hot path
    expect(orders).not.toMatch(/await flushSoon\(/);
  });
});

describe("rows and the ledger cannot disagree", () => {
  it("order and payment events enqueue INSIDE the transaction", () => {
    // `tx`, not `db` — a rolled-back order must take its Sheet row with it
    expect(orders).toMatch(/enqueueSheetEvent\(tx, "order"/);
    expect(orders).toMatch(/enqueueSheetEvent\(tx, "payment"/);
    expect(orders).toMatch(/enqueueSheetEvent\(tx, "collection"/);
  });

  it("marks rows sent only AFTER Google accepts them", () => {
    // mark-then-send loses rows silently on every failed send
    const sentAt = events.indexOf("sentAt: new Date()");
    const guard = events.indexOf("if (res.ok)");
    expect(guard).toBeGreaterThan(-1);
    expect(sentAt).toBeGreaterThan(guard);
  });

  it("records the failure on a row rather than dropping it", () => {
    expect(events).toMatch(/attempts: \{ increment: 1 \}, lastError:/);
  });

  it("gives up after a bounded number of attempts", () => {
    expect(MAX_ATTEMPTS).toBeGreaterThan(1);
    expect(events).toMatch(/attempts: \{ lt: MAX_ATTEMPTS \}/);
  });
});

describe("customer ID is resolved when the event happens", () => {
  it("looks the code up at enqueue time, not at flush time", () => {
    // codes are recycled: a later lookup could credit a March order to whoever
    // inherited the number in September
    expect(events).toMatch(/export async function customerIdFor/);
    expect(orders).toMatch(/await customerIdFor\(tx, /);
  });

  it("falls back to the internal reference when there is no bag yet", () => {
    expect(events).toMatch(/return bag\?\.code \?\? studentId/);
  });
});

describe("cost and quota", () => {
  it("groups queued rows into one append per tab", () => {
    // twenty orders in ten minutes must not be twenty Google calls
    expect(events).toMatch(/const byKind = new Map/);
    expect(events).toMatch(/for \(const \[kind, rows\] of byKind\)/);
  });

  it("appends rather than rewriting the tab", () => {
    expect(events).toMatch(/appendSheet\(/);
    expect(events).not.toMatch(/writeSheet\(/);
  });

  it("the append URL asks Google to insert rows", () => {
    expect(read("lib/sheets.ts")).toMatch(/insertDataOption=INSERT_ROWS/);
  });
});

describe("privacy", () => {
  it("no phone number reaches a Sheet row", () => {
    // name and customer ID only — a Sheet is one click from being shared
    for (const src of [events, orders, read("lib/actions/complaints.ts")]) {
      const rows = [...src.matchAll(/enqueueSheetEvent\([\s\S]{0,600}?\]\);/g)].map((m) => m[0]);
      for (const r of rows) expect(r).not.toMatch(/\.phone/);
    }
  });

  it("the privacy contract records that per-student rows are now written", () => {
    const sheets = read("lib/sheets.ts");
    // \s+ because the sentence wraps across lines in the comment block
    expect(sheets).toMatch(/Never\s+a\s+phone\s+number,\s+never\s+an\s+address/);
    expect(sheets).toMatch(/ACTION REQUIRED/); // /privacy must name Google
  });
});

describe("reliability sweep", () => {
  const route = read("app/api/sheets/flush/route.ts");

  it("is cron-authenticated and Admin+ in the app", () => {
    expect(route).toMatch(/CRON_SECRET/);
    expect(route).toMatch(/st\.role >= 3/);
  });

  it("reports rows that gave up instead of hiding them", () => {
    expect(route).toMatch(/attempts: \{ gte: MAX_ATTEMPTS \}/);
    expect(route).toMatch(/stuck/);
  });

  it("is registered as a Vercel cron the Hobby plan will accept", () => {
    // Hobby rejects anything more frequent than daily, and such an entry fails
    // the DEPLOY rather than just the cron — so this is pinned. The sub-daily
    // cadence comes from the external scheduler instead.
    const crons: { path: string; schedule: string }[] = JSON.parse(read("vercel.json")).crons;
    const flush = crons.find((c) => c.path === "/api/sheets/flush");
    expect(flush).toBeDefined();
    expect(flush!.schedule).not.toMatch(/^\*\//);
    const [min, hour] = flush!.schedule.split(" ");
    expect(min).toMatch(/^\d+$/);
    expect(hour).toMatch(/^\d+$/); // a fixed time of day, i.e. once daily
  });

  it("documents that the live cadence comes from the external scheduler", () => {
    expect(route).toMatch(/cron-job\.org/);
    expect(route).toMatch(/Hobby plan refuses|refuses any schedule/);
  });
});

describe("timestamps are IST", () => {
  it("shifts UTC by 5h30 and drops seconds", () => {
    const s = istStamp(new Date("2026-01-01T00:00:00Z"));
    expect(s).toBe("2026-01-01 05:30");
  });
});
