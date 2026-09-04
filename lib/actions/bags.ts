"use server";
/* Issuing the physical bags students carry their laundry in.

   A subscriber's first bag is complimentary — it's a perk of buying a plan, so
   a walk-in with no subscription buys theirs. Replacements are sold and posted
   as a normal counter payment so they land in the day's cash reconciliation.
   Changing plan swaps the bag free, since the code letter must follow the tier.

   Codes are never reused — see lib/bagcode.ts. A lost bag is marked lost and
   the student is issued a NEW code, because the old label is still out there
   on a bag someone may hand in. */
import { db } from "../db";
import { requireStaff, assertSameCollege } from "../auth";
import { pushNotif, audit } from "../notify";
import { rosterSoon } from "../sheets-sync";
import { publish } from "../realtime";
import { notifyOwner } from "../mail";
import { allocateBagCode, bagKindFor, isTier, BAG_LABEL, BAG_LETTER, parseBagCode, codesRemaining, WARN_AT, MAX_PER_KIND } from "../bagcode";

/** Issue a bag to a student. First one is free; later ones take a price. */
export async function issueBag(
  studentId: string,
  input: { price?: number; method?: "cash" | "upi"; note?: string } = {},
) {
  const st = await requireStaff(1);
  const stu = await db.student.findUnique({
    where: { id: studentId },
    // ordered: the free-swap check compares against the MOST RECENT bag, and
    // unordered rows would make that comparison arbitrary
    include: { subscription: { include: { planRef: true } }, bags: { orderBy: { issuedAt: "desc" } } },
  });
  if (!stu) return { ok: false as const, error: "Student not found" };
  assertSameCollege(st, stu.collegeId);

  const tier = stu.subscription?.active ? stu.subscription.planRef?.tier : null;
  // Faculty carry the F series regardless of what they have bought — the
  // letter tells the counter WHO this is, and a teacher on a cycle pack is
  // still a teacher.
  const kind = stu.kind === "faculty" ? ("faculty" as const) : bagKindFor(tier);
  const isFirstEver = stu.bags.length === 0;
  const subscribed = !!stu.subscription?.active;

  // The complimentary bag is a SUBSCRIPTION perk — "one free bag to each
  // student who subscribes". A walk-in with no plan buys theirs, otherwise
  // anyone could collect a free bag without ever paying for a plan. They still
  // get their free one later, on the day they subscribe.
  const hasHadFreeBag = stu.bags.some((b) => b.complimentary);

  // Changing plan is a free SWAP, not a sale. The code letter has to follow the
  // tier staff read off the bag — a walk-in who subscribes, or a Bronze who
  // moves to Gold, both need a new label, and billing for that would be
  // charging a student for upgrading.
  const lastKind = stu.bags[0] ? bagKindFor(stu.bags[0].tier) : null;
  const upgradingFromWalkIn = !isFirstEver && lastKind !== null && lastKind !== kind;

  const complimentary = (subscribed && !hasHadFreeBag) || upgradingFromWalkIn;
  const price = complimentary ? 0 : Math.max(0, Math.round(Number(input.price) || 0));

  let bag;
  /* allocateBagCode's recycled-code check (two findMany, no lock) can pick
     the SAME candidate code for two counters issuing bags of the same tier
     at the same instant. The partial unique index on active bags correctly
     rejects the loser at commit — no double-issuance, just an opaque
     failure — so retrying the whole transaction (a fresh allocateBagCode
     call sees the other one's now-taken code) turns that into an automatic
     success instead of a "try again" for the counter. Not needed for the
     "already has an active bag" race just below: that one is a real
     business rule refusal, not a code collision, so it must not retry. */
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      bag = await db.$transaction(async (tx) => {
        /* "Already has an active bag" was checked outside this transaction —
           two concurrent issuances for the same student (a double-tap at a
           busy counter) both saw no active bag and both proceeded, leaving
           two simultaneously "active" bags and possibly two charges. Locked
           and re-checked here, fresh, before allocating a code. */
        await tx.$executeRaw`SELECT id FROM "Bag" WHERE "studentId" = ${studentId} AND status = 'active' FOR UPDATE`;
        const stillActive = await tx.bag.findFirst({ where: { studentId, status: "active" } });
        if (stillActive) throw new Error("This student already has an active bag — mark it lost or replaced first");
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
      break;
    } catch (e) {
      const isCodeCollision = (e as { code?: string }).code === "P2002";
      if (!isCodeCollision || attempt === 2) return { ok: false as const, error: isCodeCollision ? "Couldn't allocate a code — please try again" : (e as Error).message };
    }
  }
  if (!bag) return { ok: false as const, error: "Couldn't allocate a code — please try again" };

  await pushNotif(
    studentId,
    complimentary && !upgradingFromWalkIn
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

/**
 * Make the student's customer ID match the plan they are actually on.
 *
 * The code IS the customer ID, and it lives on the bag — so until a bag was
 * issued a Silver subscriber had no S-code at all, just the internal 6-digit
 * reference. Assigning a plan and issuing the bag were two separate manual
 * steps, and nothing tied them together, so "choose Gold, get G001" simply did
 * not happen unless someone remembered the second step.
 *
 * Called after a plan is assigned or changed:
 *   - no bag yet            -> issue one, complimentary (the subscription perk)
 *   - bag of the wrong tier -> retire it and issue the new letter, free
 *   - bag already correct   -> nothing, so this is safe to call repeatedly
 *
 * Never throws. A subscription that has been paid for must not roll back
 * because a code could not be allocated; the caller reports what happened and
 * staff can issue the bag by hand.
 */
export async function syncBagToPlan(studentId: string) {
  try {
    const st = await requireStaff(1);
    const stu = await db.student.findUnique({
      where: { id: studentId },
      include: { subscription: { include: { planRef: true } }, bags: { orderBy: { issuedAt: "desc" } } },
    });
    if (!stu) return { ok: false as const, error: "Student not found" };
    assertSameCollege(st, stu.collegeId);

    const tier = stu.subscription?.active ? stu.subscription.planRef?.tier : null;
    const wanted = bagKindFor(tier);
    const active = stu.bags.find((b) => b.status === "active");

    if (active && bagKindFor(active.tier) === wanted) {
      return { ok: true as const, code: active.code, changed: false };
    }

    /* Retire the old one first: issueBag refuses while an active bag exists,
       and it reads the most recent bag to decide the swap is free — which is
       still the one just retired, so the student is not charged to upgrade. */
    if (active) {
      await db.bag.update({
        where: { id: active.id },
        data: { status: "replaced", note: `Plan changed — replaced by a ${wanted} code` },
      });
    }

    const r = await issueBag(studentId, {});
    if (!r.ok) return { ok: false as const, error: r.error };
    return { ok: true as const, code: r.code, changed: true, replaced: active?.code ?? null };
  } catch (e) {
    console.error("[bags] syncBagToPlan failed:", (e as Error).message);
    return { ok: false as const, error: (e as Error).message };
  }
}

/**
 * Replace a lost or damaged bag, KEEPING the student's number.
 *
 * The code is the student's customer ID, not the bag's. It is printed on the
 * bag, but it identifies the person — so losing a bag must not change who they
 * are. They are handed a fresh bag with the same number on it.
 *
 * The old row is kept, marked lost, so the history shows a replacement
 * happened and when. The database allows both rows to carry the code because
 * only one of them is ACTIVE.
 *
 * The trade-off, chosen deliberately: if the lost bag is handed in after the
 * replacement is printed, two physical bags carry that number. The found one
 * must be destroyed, never returned to stock. The alternative — a new number
 * on every loss — is what makes an ID stop being permanent.
 *
 * Free. A student does not pay for losing a bag any more than for upgrading;
 * charge for it at the counter as a separate sale if you want to.
 */
export async function reissueBagSameCode(bagId: string, reason: "lost" | "damaged" = "lost") {
  const st = await requireStaff(1);
  const bag = await db.bag.findUnique({ where: { id: bagId }, include: { student: true } });
  if (!bag) return { ok: false as const, error: "Bag not found" };
  assertSameCollege(st, bag.student.collegeId);
  if (bag.status !== "active") return { ok: false as const, error: `That bag is already marked ${bag.status}` };

  const fresh = await db.$transaction(async (tx) => {
    /* Retire first. The unique index allows one ACTIVE bag per code, so the
       old row has to stop being active before the new one starts. */
    await tx.bag.update({
      where: { id: bagId },
      data: { status: "lost", note: `${reason} — reissued with the same code` },
    });
    return tx.bag.create({
      data: {
        code: bag.code, // the whole point: same number, new bag
        studentId: bag.studentId,
        tier: bag.tier,
        complimentary: true,
        price: 0,
        issuedBy: st.id,
        note: `Replacement for a ${reason} bag`,
      },
    });
  });

  await pushNotif(bag.studentId, `Your replacement bag is ready — same number, ${bag.code}. Collect it at the counter.`, "status");
  await audit("Bag reissued", `${bag.code} · ${bag.student.name} · ${reason}, same code`, st.id);
  publish([`student:${bag.studentId}`, `orders:${bag.student.collegeId}`], { type: "bag", payload: { studentId: bag.studentId, code: bag.code } });
  return { ok: true as const, code: fresh.code };
}

/**
 * Change a student's customer ID to a specific code.
 *
 * For the case the allocator cannot know about: the counter has a printed bag
 * in hand and the student must end up with the number on it. Renaming the
 * existing bag rather than issuing a new one keeps one row, one history, and
 * no second code drifting about.
 *
 * It propagates by itself. Every screen — the student's home card, the QR, the
 * staff customer page, future Sheet rows — reads the code from this row at
 * render time, so there is nothing else to update. Sheet rows ALREADY written
 * keep the old code on purpose: they record what the code was on the day, and
 * rewriting history would make the log disagree with the receipts.
 *
 * Admin+, because this is the student's identity, and audited both values.
 */
export async function setBagCode(bagId: string, rawCode: string) {
  const st = await requireStaff(3);
  const bag = await db.bag.findUnique({ where: { id: bagId }, include: { student: { include: { subscription: { include: { planRef: true } } } } } });
  if (!bag) return { ok: false as const, error: "Bag not found" };
  assertSameCollege(st, bag.student.collegeId);
  if (bag.status === "released") return { ok: false as const, error: "This code has been released — issue a new bag instead" };

  const code = (rawCode || "").trim().toUpperCase();
  const parsed = parseBagCode(code);
  if (!parsed) return { ok: false as const, error: "Use a code like B001, S042 or G250 — a letter and three digits" };
  if (code === bag.code) return { ok: true as const, code, changed: false };

  /* The letter has to match the plan they are actually on, or the bag lies
     about the tier — and the letter is what staff read at the counter to know
     which service the student is entitled to. */
  const tier = bag.student.subscription?.active ? bag.student.subscription.planRef?.tier : null;
  const expected = bagKindFor(tier);
  if (parsed.kind !== expected) {
    return {
      ok: false as const,
      error: `${bag.student.name} is on ${BAG_LABEL[expected]}, so the code must start with ${BAG_LETTER[expected]}. Change their plan first if that is what you meant.`,
    };
  }

  /* Checked here for a readable message; the partial unique index is what
     actually guarantees it, including against a simultaneous edit. */
  const clash = await db.bag.findFirst({
    where: { code, status: { not: "released" }, NOT: { id: bagId } },
    include: { student: { select: { name: true } } },
  });
  if (clash) return { ok: false as const, error: `${code} is already held by ${clash.student.name}` };

  const before = bag.code;
  try {
    await db.bag.update({ where: { id: bagId }, data: { code } });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return { ok: false as const, error: `${code} was just taken by someone else — pick another` };
    throw e;
  }

  await audit("Customer ID changed", `${bag.student.name} · ${before} → ${code}`, st.id);
  rosterSoon();
  // They carry this number and quote it at the counter, so they are told.
  await pushNotif(bag.studentId, `Your FabricFold customer ID is now ${code} (was ${before}).`, "status");
  publish([`student:${bag.studentId}`, `orders:${bag.student.collegeId}`], { type: "bag", payload: { studentId: bag.studentId, code } });
  return { ok: true as const, code, changed: true, previous: before };
}

/**
 * Release a customer ID back to the pool — the student has left the campus.
 *
 * This is the ONLY route by which a code is reused. Marking a bag lost or
 * replaced deliberately does not free it: a lost bag turns up weeks later and
 * must still name the student it was issued to, not whoever inherited the
 * number in the meantime.
 *
 * Manager+ rather than counter staff. Releasing a code detaches a student from
 * the identity printed on their bag, and the next person to be issued that
 * number inherits it — not a decision to make by mis-tap during a queue.
 */
export async function releaseBagCode(bagId: string, note?: string) {
  const st = await requireStaff(2); // Manager+
  const bag = await db.bag.findUnique({ where: { id: bagId }, include: { student: true } });
  if (!bag) return { ok: false as const, error: "Bag not found" };
  assertSameCollege(st, bag.student.collegeId);
  if (bag.status === "released") return { ok: false as const, error: "This code has already been released" };

  /* Refuse while the student can still place orders against it. Releasing a
     code mid-plan would hand a live subscriber's identity to someone else. */
  const sub = await db.subscription.findUnique({ where: { studentId: bag.studentId } });
  if (sub?.active) {
    return { ok: false as const, error: "This student still has an active plan — cancel or let it expire before releasing their code" };
  }
  const openOrders = await db.order.count({
    where: { studentId: bag.studentId, status: { notIn: ["collected", "cancelled"] } },
  });
  if (openOrders) {
    return { ok: false as const, error: `${openOrders} order(s) still open for this student — finish them before releasing the code` };
  }

  await db.bag.update({
    where: { id: bagId },
    data: { status: "released", releasedAt: new Date(), note: note?.trim() || bag.note },
  });
  await audit("Customer ID released", `${bag.code} · ${bag.student.name}${note ? ` — ${note}` : ""}`, st.id);
  rosterSoon();
  publish([`student:${bag.studentId}`], { type: "bag", payload: { studentId: bag.studentId } });
  return { ok: true as const, code: bag.code };
}

/** Mark a bag lost or replaced. The code stays reserved — see releaseBagCode. */
export async function retireBag(bagId: string, status: "lost" | "replaced", note?: string) {
  const st = await requireStaff(1);
  const bag = await db.bag.findUnique({ where: { id: bagId }, include: { student: true } });
  if (!bag) return { ok: false as const, error: "Bag not found" };
  assertSameCollege(st, bag.student.collegeId);
  if (bag.status !== "active") return { ok: false as const, error: `This bag is already marked ${bag.status}` };

  // Claim atomically on the status still being "active" — two near-simultaneous
  // retireBag calls (e.g. "lost" then "replaced" tapped back to back) would
  // otherwise both pass the check above and the second write silently wins.
  const claimed = await db.bag.updateMany({
    where: { id: bagId, status: "active" },
    data: { status, note: note?.trim() || bag.note },
  });
  if (claimed.count === 0) return { ok: false as const, error: "This bag was just updated by someone else — refresh and try again" };
  await audit("Bag retired", `${bag.code} · ${bag.student.name} · ${status}${note ? ` — ${note}` : ""}`, st.id);
  publish([`student:${bag.studentId}`], { type: "bag", payload: { studentId: bag.studentId } });
  return { ok: true as const };
}
