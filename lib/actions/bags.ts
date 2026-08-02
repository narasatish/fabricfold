"use server";
/* Issuing the physical bags students carry their laundry in.

   The first bag a student ever receives is complimentary; replacements are
   sold and posted as a normal counter payment so they show up in the day's
   cash reconciliation like any other sale.

   Codes are never reused — see lib/bagcode.ts. A lost bag is marked lost and
   the student is issued a NEW code, because the old label is still out there
   on a bag someone may hand in. */
import { db } from "../db";
import { requireStaff } from "../auth";
import { pushNotif, audit } from "../notify";
import { publish } from "../realtime";
import { notifyOwner } from "../mail";
import { allocateBagCode, bagKindFor, isTier, BAG_LABEL, parseBagCode, codesRemaining, WARN_AT, MAX_PER_KIND } from "../bagcode";

/** Issue a bag to a student. First one is free; later ones take a price. */
export async function issueBag(
  studentId: string,
  input: { price?: number; method?: "cash" | "upi"; note?: string } = {},
) {
  const st = await requireStaff(1);
  const stu = await db.student.findUnique({
    where: { id: studentId },
    include: { subscription: { include: { planRef: true } }, bags: true },
  });
  if (!stu) return { ok: false as const, error: "Student not found" };

  // A student should be carrying one bag at a time. Selling a second while the
  // first is still active is almost always a mis-click — make them mark the old
  // one lost first, so the code history stays truthful.
  if (stu.bags.some((b) => b.status === "active")) {
    return { ok: false as const, error: "This student already has an active bag — mark it lost or replaced first" };
  }

  const tier = stu.subscription?.active ? stu.subscription.planRef?.tier : null;
  const kind = bagKindFor(tier);
  const isFirstEver = stu.bags.length === 0;

  // Changing plan is a free SWAP, not a replacement sale. The code letter has
  // to follow the tier staff read off the bag — a walk-in who subscribes, or a
  // Bronze who moves to Gold, both need a new label. Charging for that would be
  // billing a student for upgrading their plan.
  const lastKind = stu.bags[0] ? bagKindFor(stu.bags[0].tier) : null;
  const upgradingFromWalkIn = !isFirstEver && lastKind !== null && lastKind !== kind;

  const complimentary = isFirstEver || upgradingFromWalkIn;
  const price = complimentary ? 0 : Math.max(0, Math.round(Number(input.price) || 0));

  let bag;
  try {
    bag = await db.$transaction(async (tx) => {
      const code = await allocateBagCode(tx, kind);
      const b = await tx.bag.create({
        data: {
          code, studentId, tier: isTier(tier) ? tier : null,
          complimentary, price, issuedBy: st.id,
          note: input.note?.trim() || null,
        },
      });
      if (price > 0) {
        await tx.payment.create({
          data: { method: input.method || "cash", amount: price, collegeId: stu.collegeId, studentId, note: `Bag ${code}` },
        });
      }
      return b;
    });
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }

  await pushNotif(
    studentId,
    isFirstEver
      ? `Your FabricFold bag ${bag.code} is ready — it's on us. Bring it along on your wash day.`
      : upgradingFromWalkIn
        ? `Your new ${BAG_LABEL[kind]} bag ${bag.code} is ready — no charge for the plan change.`
        : `Replacement bag ${bag.code} issued${price > 0 ? ` (₹${price})` : ""}.`,
    "status",
  );
  await audit(
    "Bag issued",
    `${bag.code} · ${stu.name} · ${BAG_LABEL[kind]}${complimentary ? (upgradingFromWalkIn ? " · plan change, free" : " · complimentary") : ` · ₹${price}`}`,
    st.id,
  );
  // Running out of codes can't be fixed at the counter — bags are printed in
  // advance — so warn the Owner with lead time rather than failing on bag 1000.
  const seq = parseBagCode(bag.code)?.n ?? 0;
  const left = codesRemaining(seq);
  if (seq >= WARN_AT) {
    void notifyOwner(
      `Bag codes running out — ${BAG_LABEL[kind]}`,
      `Just issued ${bag.code}. Only ${left} of ${MAX_PER_KIND} ${BAG_LABEL[kind]} codes remain. Widen the code scheme before the next print run.`,
    );
  }

  publish([`student:${studentId}`, `orders:${stu.collegeId}`], { type: "bag", payload: { studentId, code: bag.code } });
  return { ok: true as const, code: bag.code, complimentary, price, codesLeft: left };
}

/** Mark a bag lost or replaced. The code is retired, never handed out again. */
export async function retireBag(bagId: string, status: "lost" | "replaced", note?: string) {
  const st = await requireStaff(1);
  const bag = await db.bag.findUnique({ where: { id: bagId }, include: { student: true } });
  if (!bag) return { ok: false as const, error: "Bag not found" };
  if (bag.status !== "active") return { ok: false as const, error: `This bag is already marked ${bag.status}` };

  await db.bag.update({
    where: { id: bagId },
    data: { status, note: note?.trim() || bag.note },
  });
  await audit("Bag retired", `${bag.code} · ${bag.student.name} · ${status}${note ? ` — ${note}` : ""}`, st.id);
  publish([`student:${bag.studentId}`], { type: "bag", payload: { studentId: bag.studentId } });
  return { ok: true as const };
}
