/* Fixed-window rate limiting, stored in the database.

   Not in memory: serverless instances don't share it, so an in-process counter
   resets on every cold start and each instance counts separately — which is no
   limit at all, only the appearance of one.

   Fixed windows are slightly coarser than a sliding window (a burst can span a
   boundary and briefly allow 2x), but they need one row and one query. For
   stopping SMS-bombing that is the right trade; a sliding log would cost more
   than the abuse it prevents. */
import { db, dbSchemaPrefix } from "./db";
import { Prisma } from "./generated/prisma/client";

export type LimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
};

/**
 * Count one hit against `key`, allowing at most `max` per `windowSec`.
 * Fails OPEN: if the limiter itself errors, the request proceeds. A student
 * unable to log in because the rate-limit table is unhappy is worse than the
 * abuse this prevents.
 */
export async function rateLimit(key: string, max: number, windowSec: number): Promise<LimitResult> {
  const now = new Date();
  const windowMs = windowSec * 1000;

  try {
    /* ONE atomic statement, not read-then-decide-then-write. The previous
       version was three round trips (read, then either an upsert or an
       increment), with no lock across them — under concurrent load
       (multiple requests for the same key, e.g. an SMS-bombing attempt
       firing many requests at once) every one of them could read the
       "before" state and every one would then independently reset the
       counter to 1, defeating the limiter entirely: the exact abuse this
       exists to stop. INSERT ... ON CONFLICT serializes on the row's own
       lock, so concurrent callers queue instead of racing. */
    const table = Prisma.raw(`${dbSchemaPrefix}"RateLimit"`);
    const rows = await db.$queryRaw<{ windowStart: Date; count: number }[]>`
      INSERT INTO ${table} (key, "windowStart", count)
      VALUES (${key}, ${now}, 1)
      ON CONFLICT (key) DO UPDATE SET
        "windowStart" = CASE WHEN ${table}."windowStart" <= ${new Date(now.getTime() - windowMs)} THEN ${now} ELSE ${table}."windowStart" END,
        count = CASE WHEN ${table}."windowStart" <= ${new Date(now.getTime() - windowMs)} THEN 1 ELSE ${table}.count + 1 END
      RETURNING "windowStart", count
    `;
    const row = rows[0];

    if (row.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((row.windowStart.getTime() + windowMs - now.getTime()) / 1000));
      return { allowed: false, remaining: 0, retryAfterSec };
    }
    return { allowed: true, remaining: Math.max(0, max - row.count), retryAfterSec: 0 };
  } catch (e) {
    console.error("rateLimit failed open:", (e as Error).message);
    return { allowed: true, remaining: max, retryAfterSec: 0 };
  }
}

/** Rough client IP from the proxy headers Vercel sets. */
export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return headers.get("x-real-ip") || "unknown";
}

/* next/headers throws outside a request scope, which made requestOtp
   uncallable from tests and scripts — it exploded before reaching any of the
   logic under test. The IP is best-effort by nature, so a missing one degrades
   to "unknown" (which skips the IP cap) rather than taking the whole action
   down. */
export async function requestIp(): Promise<string> {
  try {
    const { headers } = await import("next/headers");
    return clientIp(await headers());
  } catch {
    return "unknown";
  }
}

/** Drop windows that closed long ago, so the table can't grow forever. */
export async function pruneRateLimits(olderThanSec = 24 * 3600) {
  const cutoff = new Date(Date.now() - olderThanSec * 1000);
  const r = await db.rateLimit.deleteMany({ where: { windowStart: { lt: cutoff } } });
  return r.count;
}
