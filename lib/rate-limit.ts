/* Fixed-window rate limiting, stored in the database.

   Not in memory: serverless instances don't share it, so an in-process counter
   resets on every cold start and each instance counts separately — which is no
   limit at all, only the appearance of one.

   Fixed windows are slightly coarser than a sliding window (a burst can span a
   boundary and briefly allow 2x), but they need one row and one query. For
   stopping SMS-bombing that is the right trade; a sliding log would cost more
   than the abuse it prevents. */
import { db } from "./db";

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
    const row = await db.rateLimit.findUnique({ where: { key } });

    // No row, or the previous window has passed: start a fresh one.
    if (!row || now.getTime() - row.windowStart.getTime() >= windowMs) {
      await db.rateLimit.upsert({
        where: { key },
        create: { key, windowStart: now, count: 1 },
        update: { windowStart: now, count: 1 },
      });
      return { allowed: true, remaining: max - 1, retryAfterSec: 0 };
    }

    if (row.count >= max) {
      const retryAfterSec = Math.max(1, Math.ceil((row.windowStart.getTime() + windowMs - now.getTime()) / 1000));
      return { allowed: false, remaining: 0, retryAfterSec };
    }

    const updated = await db.rateLimit.update({ where: { key }, data: { count: { increment: 1 } } });
    return { allowed: true, remaining: Math.max(0, max - updated.count), retryAfterSec: 0 };
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

/** Drop windows that closed long ago, so the table can't grow forever. */
export async function pruneRateLimits(olderThanSec = 24 * 3600) {
  const cutoff = new Date(Date.now() - olderThanSec * 1000);
  const r = await db.rateLimit.deleteMany({ where: { windowStart: { lt: cutoff } } });
  return r.count;
}
