/* Server-side slot guard. Deliberately NOT a "use server" module: this is an
   internal helper for placeOrder, not something the client may call directly. */
import { Prisma } from "./generated/prisma/client";
import { buildSlots, type Win } from "./slots";

export const BOOK_AHEAD_DAYS = 5;

type Tx = Prisma.TransactionClient;

/** Is `startAtISO` a real, still-bookable, non-full drop-off window for this
    college? Returns the matching window's end instant. Throws with a
    user-safe message otherwise.

    MUST be called with `tx` bound to a transaction that ALSO creates the
    order for this slot, in the same transaction — this function only takes
    the advisory lock and checks capacity, it does not (and cannot) enforce
    that nothing else books the slot in the gap before the caller's insert.
    Found 2026-09-05: the previous version was a bare `db.order.count` with
    no lock at all, called from placeOrder well before its own
    `db.order.create` — completely unserialized, so N students booking the
    slot with exactly one seat left could all read the same "before" count,
    all pass the capacity check, and all create a draft order for it,
    silently exceeding the capacity the whole feature exists to enforce (the
    counter queue this was meant to spread stays exactly as overloaded as
    without it). A SlotWindow row is a recurring WEEKLY TEMPLATE, not a
    per-instance row for one actual date+time — there is no physical row
    representing "this college's 9am Tuesday slot" to SELECT ... FOR UPDATE,
    so this uses a Postgres advisory lock keyed by a hash of
    (collegeId, startAtISO) instead: same serialization guarantee as a row
    lock, for a logical resource that has no row. `pg_advisory_xact_lock`
    auto-releases when the transaction ends (commit or rollback), so there is
    no separate unlock step and no leak if the caller's insert throws. */
export async function assertSlotBookable(tx: Tx, collegeId: string, startAtISO: string) {
  const startAt = new Date(startAtISO);
  if (Number.isNaN(+startAt)) throw new Error("Invalid slot");

  const lockKey = `${collegeId}|${startAtISO}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

  const windows = await tx.slotWindow.findMany({ where: { collegeId, active: true } });
  const match = buildSlots(windows as unknown as Win[], BOOK_AHEAD_DAYS, new Date())
    .find((c) => +c.startAt === +startAt);
  if (!match) throw new Error("That slot is no longer available");

  // A plain Prisma ORM count, not raw SQL — the ORM already respects the
  // connection's ?schema= param the way raw $queryRaw/$executeRaw does not
  // (see dbSchemaPrefix's own comment in db.ts); only the advisory lock
  // above needs the raw escape hatch, since Prisma has no ORM call for it.
  const taken = await tx.order.count({
    where: { collegeId, dropSlotAt: startAt, status: { in: ["draft", "received"] } },
  });
  if (taken >= match.capacity) throw new Error("That slot just filled up — pick another");
  return match.endAt;
}
