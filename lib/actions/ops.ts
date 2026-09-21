"use server";
/* Operations: staff attendance, day-close cash ritual, wallet top-ups. */
import { db } from "../db";
import { requireStaff, requireStaffPerm, assertSameCollege } from "../auth";
import { audit } from "../notify";
import { notifyOwner } from "../mail";
import { computeReport, parsePeriod } from "../report";

/** IST business date (server may run in any timezone). */
function istToday() {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/* ---------- Attendance ---------- */
export async function clockIn() {
  const st = await requireStaff(1);
  const date = istToday();
  const existing = await db.attendance.findUnique({ where: { staffId_date: { staffId: st.id, date } } });
  if (existing) return { ok: false as const, error: existing.clockOut ? "Already clocked out for today" : "Already clocked in" };
  try {
    await db.attendance.create({ data: { staffId: st.id, date } });
  } catch (e) {
    // The pre-check above ran before this create — two concurrent clock-in
    // taps both pass it, and the second hits the unique constraint on
    // (staffId, date) and throws unhandled. Guard against it here.
    if ((e as { code?: string }).code === "P2002") return { ok: false as const, error: "Already clocked in" };
    throw e;
  }
  await audit("Clock in", `${st.name} · ${date}`, st.id);
  return { ok: true as const };
}

export async function clockOut() {
  const st = await requireStaff(1);
  const date = istToday();
  const rec = await db.attendance.findUnique({ where: { staffId_date: { staffId: st.id, date } } });
  if (!rec) return { ok: false as const, error: "Clock in first" };
  if (rec.clockOut) return { ok: false as const, error: "Already clocked out" };

  /* Atomic update: only proceed if this record still has no clockOut. Two
     concurrent clock-out taps both pass the check above, and the second
     would silently overwrite the first's clockOut timestamp. Using updateMany
     with a WHERE condition ensures only one succeeds. */
  const updated = await db.attendance.updateMany({
    where: { id: rec.id, clockOut: null },
    data: { clockOut: new Date() }
  });
  if (updated.count === 0) return { ok: false as const, error: "Already clocked out" };

  const hours = ((Date.now() - rec.clockIn.getTime()) / 3600_000).toFixed(1);
  await audit("Clock out", `${st.name} · ${date} · ${hours}h`, st.id);
  return { ok: true as const, hours };
}

/* ---------- Day close (Manager+) ----------
   Staff physically count the cash drawer; the app records counted vs expected.
   A non-zero variance is permanent evidence — the anti-theft ritual. */
export async function closeDay(countedCash: number, note?: string, collegeId?: string | null) {
  const st = await requireStaffPerm("dayclose");
  const date = istToday();
  /* Each college has its own cash drawer, so each closes its own day. Campus
     staff can only close their own; an owner picks a campus (validated) or
     passes none to close the whole business. */
  let scope = st.collegeId ?? "";
  if (!st.collegeId && collegeId) {
    if (!(await db.college.findUnique({ where: { id: collegeId }, select: { id: true } }))) return { ok: false as const, error: "Unknown college" };
    scope = collegeId;
  }
  if (await db.dayClose.findUnique({ where: { date_collegeId: { date, collegeId: scope } } })) return { ok: false as const, error: "Today is already closed" };
  if (countedCash < 0 || !Number.isFinite(countedCash)) return { ok: false as const, error: "Enter the counted cash amount" };

  const r = await computeReport(parsePeriod({ p: "day" }), scope || null);
  const expected = r.expectedDrawer;
  const variance = Math.round((countedCash - expected) * 100) / 100;

  try {
    await db.dayClose.create({ data: { date, collegeId: scope, expectedCash: expected, countedCash, variance, note: note?.trim() || null, by: st.id } });
  } catch (e) {
    // Two concurrent close-day taps both pass the pre-check above, and the
    // second hits the unique constraint on `date`. Catch and return the same
    // friendly error as the pre-check, not a raw constraint violation.
    if ((e as { code?: string }).code === "P2002") return { ok: false as const, error: "Today is already closed" };
    throw e;
  }
  await audit("Day closed", `${date} · counted ₹${countedCash} vs expected ₹${expected} · variance ₹${variance}`, st.id);
  /* Awaited, not void: a floating promise is abandoned when Vercel freezes
     the instance, and the variance mail is the one this ritual exists for.
     Above ₹200 the subject escalates to an explicit alert — a drawer that is
     out by lunch money reads differently from one out by a day's takings. */
  const alert = Math.abs(variance) > 200;
  await notifyOwner(
    alert
      ? `⚠ CASH VARIANCE ₹${variance} — needs a look`
      : `Day closed — ${variance === 0 ? "drawer matches ✓" : `variance ₹${variance}`}`,
    `${date}: expected ₹${expected}, counted ₹${countedCash}, variance ₹${variance}. Closed by ${st.name}.${note ? ` Note: ${note}` : ""}${alert ? " || Over the ₹200 threshold — check the payments list for the day before the detail goes cold." : ""}`,
  );
  return { ok: true as const, expected, variance };
}

export async function todayClose() {
  const st = await requireStaff(1);
  const rec = await db.dayClose.findUnique({ where: { date_collegeId: { date: istToday(), collegeId: st.collegeId ?? "" } } });
  return rec ? { closed: true as const, variance: Number(rec.variance) } : { closed: false as const };
}

/* ---------- Google Sheets sync (Owner) ---------- */
export async function syncSheetsNow() {
  const st = await requireStaff(4);
  const { runSheetsSync } = await import("../sheets-sync");
  const r = await runSheetsSync();
  if (r.ok) await audit("Sheets sync", `manual · ${r.tabs.join(", ")}`, st.id);
  return r;
}

/* ---------- Error log (Owner) ---------- */
export async function markErrorsSeen() {
  await requireStaff(4);
  await db.errorLog.updateMany({ where: { seen: false }, data: { seen: true } });
  return { ok: true as const };
}

/* ---------- Wallet top-up (any staff; money physically received first) ---------- */
export async function topUpCredits(studentId: string, amount: number, method: "cash" | "upi") {
  const st = await requireStaff(1);
  amount = Math.floor(amount);
  if (!amount || amount <= 0 || amount > 50_000) return { ok: false as const, error: "Enter a valid amount" };
  const stu = await db.student.findUnique({ where: { id: studentId } });
  if (!stu) return { ok: false as const, error: "Student not found" };
  assertSameCollege(st, stu.collegeId);

  try {
    await db.$transaction(async (tx) => {
      /* Unlike every other money-writing action in this file (clockIn,
         clockOut, closeDay), a top-up has no natural key to hang a real
         unique index on — the SAME student legitimately tops up the SAME
         amount by the SAME method more than once in a day, so a blanket
         constraint would block genuine repeats. But a double-tap (or a
         retried request on a flaky counter connection) lands within
         moments of the same STAFF MEMBER's own click — something a second,
         later, genuine top-up from that staff member essentially never
         does. Lock on studentId (same technique as bags.ts's bag-issue
         lock) and refuse an identical top-up from the same staff member
         inside a short window, closing the double-tap gap other money
         paths get from a unique index, without blocking a real repeat. */
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`topup|${studentId}`}))`;
      const recent = await tx.payment.findFirst({
        where: { studentId, method, amount, note: "Wallet top-up", at: { gte: new Date(Date.now() - 10_000) } },
      });
      if (recent) throw new Error("This top-up was just recorded — check the wallet before adding it again");
      await tx.student.update({ where: { id: studentId }, data: { credits: { increment: amount } } });
      await tx.payment.create({ data: { method, amount, collegeId: stu.collegeId, studentId, note: "Wallet top-up" } });
      // appears in the student's wallet ledger as money added
      await tx.compensation.create({ data: { studentId, kind: "topup", amount, method: "credit", comment: `Top-up (${method})`, by: st.id } });
    }, { timeout: 15_000 }); // advisory lock can queue a concurrent caller past Prisma's 5s default — same class as bags.ts/subscription.ts
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
  await audit("Wallet top-up", `${stu.name} · ₹${amount} (${method})`, st.id);
  void notifyOwner("Wallet top-up", `${stu.name} added ₹${amount} by ${method.toUpperCase()} (taken by ${st.name}).`);
  return { ok: true as const };
}
