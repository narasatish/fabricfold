/* Server-side slot guard. Deliberately NOT a "use server" module: this is an
   internal helper for placeOrder, not something the client may call directly. */
import { db } from "./db";
import { buildSlots, type Win } from "./slots";

export const BOOK_AHEAD_DAYS = 5;

/** Is `startAtISO` a real, still-bookable, non-full drop-off window for this
    college? Returns the matching window's end instant. Throws with a
    user-safe message otherwise. Capacity is re-checked here (never trusted
    from the client) so two students can't take the last seat at once. */
export async function assertSlotBookable(collegeId: string, startAtISO: string) {
  const startAt = new Date(startAtISO);
  if (Number.isNaN(+startAt)) throw new Error("Invalid slot");

  const windows = await db.slotWindow.findMany({ where: { collegeId, active: true } });
  const match = buildSlots(windows as unknown as Win[], BOOK_AHEAD_DAYS, new Date())
    .find((c) => +c.startAt === +startAt);
  if (!match) throw new Error("That slot is no longer available");

  const taken = await db.order.count({
    where: { collegeId, dropSlotAt: startAt, status: { in: ["draft", "received"] } },
  });
  if (taken >= match.capacity) throw new Error("That slot just filled up — pick another");
  return match.endAt;
}
