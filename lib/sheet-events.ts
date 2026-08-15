/* Live Google Sheet log — one row per business event, appended as it happens.

   WHY AN OUTBOX AND NOT A DIRECT WRITE

   The obvious implementation calls Google from inside acceptOrder. That makes
   the counter wait on a third party for every order, and worse, couples them:
   if Sheets is slow the student stands there, and if Sheets throws the order
   fails. Neither is acceptable for a queue at a laundry desk.

   So the event is INSERTED in the same transaction as the thing it describes.
   That is the only step that must succeed, it is a local write measured in
   milliseconds, and it means the Sheet can never miss a real order nor record
   one that was rolled back. Delivery happens afterwards and can fail freely.

   Two things drain the outbox, deliberately overlapping:
     - a fire-and-forget flush right after the action, which is what makes it
       feel live — usually a second or two behind the counter
     - a cron sweep, which is what makes it RELIABLE. Serverless functions can
       be frozen the instant a response is sent, so the fire-and-forget flush
       is an optimisation that may simply not run. Anything it misses is picked
       up on the next sweep.

   The aggregate tabs (Live, Daily, Plans…) are untouched and still rebuild on
   the daily sync. This adds an append-only log beside them; it does not
   replace the totals. */
import { after } from "next/server";
import { db } from "./db";
import { appendSheet, sheetsConfigured } from "./sheets";
import type { Prisma } from "./generated/prisma/client";

/** One tab per kind, so a reader can filter without formulas. */
const TAB: Record<string, string> = {
  order: "Orders",
  payment: "Payments",
  complaint: "Complaint log",
  collection: "Collections",
};

const HEADER: Record<string, string[]> = {
  order: ["When (IST)", "Order", "Customer ID", "Student", "Campus", "Service", "Pieces", "Total", "Paid by", "On plan", "Status"],
  payment: ["When (IST)", "Order", "Customer ID", "Student", "Method", "Amount", "GST", "Invoice"],
  complaint: ["When (IST)", "Order", "Customer ID", "Student", "Issue", "Photos", "Raised by"],
  collection: ["When (IST)", "Order", "Customer ID", "Student", "Pieces", "Collected by"],
};

/** How many attempts before a row is left alone for a human to look at. */
export const MAX_ATTEMPTS = 5;

export function istStamp(d: Date = new Date()) {
  return new Date(d.getTime() + 5.5 * 3600_000).toISOString().replace("T", " ").slice(0, 16);
}

/**
 * The customer ID to print on a Sheet row — the code on the student's bag.
 *
 * Resolved at ENQUEUE time, not at flush time, and that is the whole point.
 * Codes are recycled when a student leaves, so looking one up later could
 * attribute a March order to whoever inherited the number in September. The
 * row records who it was on the day.
 *
 * Falls back to the internal reference for students who have no bag yet.
 */
export async function customerIdFor(
  client: Prisma.TransactionClient | typeof db,
  studentId: string,
): Promise<string> {
  const bag = await client.bag.findFirst({
    where: { studentId, status: "active" },
    orderBy: { issuedAt: "desc" },
    select: { code: true },
  });
  return bag?.code ?? studentId;
}

/**
 * Queue one row. Pass the transaction client when there is one, so the event
 * commits or rolls back with the business change.
 *
 * Never throws: a Sheet is a report, and failing to write a report must not
 * roll back a real order. A lost row is visible later as an unsent outbox
 * entry, which is recoverable; a rejected order is not.
 */
export async function enqueueSheetEvent(
  client: Prisma.TransactionClient | typeof db,
  kind: keyof typeof TAB | string,
  row: (string | number)[],
) {
  try {
    await client.sheetOutbox.create({ data: { kind, payload: row as unknown as Prisma.InputJsonValue } });
  } catch (e) {
    console.error("[sheets] enqueue failed:", (e as Error).message);
  }
}

/**
 * Send queued rows, oldest first, grouped into one append per tab.
 *
 * Grouping matters: twenty orders in a busy ten minutes is twenty rows but
 * only one Google call per tab, which keeps this far inside the API quota.
 */
export async function flushSheetOutbox(limit = 200) {
  if (!sheetsConfigured()) return { ok: false as const, error: "Google Sheets not configured", sent: 0 };

  const pending = await db.sheetOutbox.findMany({
    where: { sentAt: null, attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { at: "asc" },
    take: limit,
  });
  if (!pending.length) return { ok: true as const, sent: 0, failed: 0 };

  const byKind = new Map<string, typeof pending>();
  for (const p of pending) {
    const list = byKind.get(p.kind) ?? [];
    list.push(p);
    byKind.set(p.kind, list);
  }

  let sent = 0, failed = 0;
  for (const [kind, rows] of byKind) {
    const tab = TAB[kind] || "Events";
    const res = await appendSheet(
      tab,
      rows.map((r) => r.payload as unknown as (string | number)[]),
      HEADER[kind],
    );
    const ids = rows.map((r) => r.id);

    if (res.ok) {
      /* Marked sent only AFTER Google accepted them. The other order — mark
         then send — loses rows silently whenever a send fails, which is the
         one outcome an outbox exists to prevent. */
      await db.sheetOutbox.updateMany({ where: { id: { in: ids } }, data: { sentAt: new Date() } });
      sent += rows.length;
    } else {
      await db.sheetOutbox.updateMany({
        where: { id: { in: ids } },
        data: { attempts: { increment: 1 }, lastError: res.error.slice(0, 300) },
      });
      failed += rows.length;
      console.error(`[sheets] append to ${tab} failed: ${res.error}`);
    }
  }
  return { ok: true as const, sent, failed };
}

/**
 * Kick a flush without making the caller wait.
 *
 * Uses next/server's `after`, which runs the callback once the response has
 * been sent AND keeps the serverless function alive until it finishes. A bare
 * `void flushSheetOutbox()` does not: Vercel freezes the instance the moment
 * the response goes out, so the promise is abandoned mid-flight.
 *
 * That is not theoretical. It was the first implementation, and a real walk-in
 * order on production sat unsent twenty seconds later — the row only moved
 * when the flush endpoint was called by hand. Same code, same order, the only
 * difference being who kept the process alive.
 *
 * `after` throws outside a request scope, so scripts, tests and the cron route
 * fall back to awaiting nothing and rely on the sweep.
 */
export function flushSoon() {
  const run = () =>
    flushSheetOutbox().catch((e) => console.error("[sheets] flush failed:", (e as Error).message));
  try {
    after(run);
  } catch {
    void run();
  }
}

/** Drop rows that were delivered a while ago; keep failures for inspection. */
export async function pruneSheetOutbox(olderThanDays = 7) {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const r = await db.sheetOutbox.deleteMany({ where: { sentAt: { not: null, lt: cutoff } } });
  return r.count;
}
