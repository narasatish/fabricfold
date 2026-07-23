"use server";
/* Operations: staff attendance, day-close cash ritual, wallet top-ups. */
import { db } from "../db";
import { requireStaff } from "../auth";
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
  await db.attendance.create({ data: { staffId: st.id, date } });
  await audit("Clock in", `${st.name} · ${date}`, st.id);
  return { ok: true as const };
}

export async function clockOut() {
  const st = await requireStaff(1);
  const date = istToday();
  const rec = await db.attendance.findUnique({ where: { staffId_date: { staffId: st.id, date } } });
  if (!rec) return { ok: false as const, error: "Clock in first" };
  if (rec.clockOut) return { ok: false as const, error: "Already clocked out" };
  await db.attendance.update({ where: { id: rec.id }, data: { clockOut: new Date() } });
  const hours = ((Date.now() - rec.clockIn.getTime()) / 3600_000).toFixed(1);
  await audit("Clock out", `${st.name} · ${date} · ${hours}h`, st.id);
  return { ok: true as const, hours };
}

/* ---------- Day close (Manager+) ----------
   Staff physically count the cash drawer; the app records counted vs expected.
   A non-zero variance is permanent evidence — the anti-theft ritual. */
export async function closeDay(countedCash: number, note?: string) {
  const st = await requireStaff(2);
  const date = istToday();
  if (await db.dayClose.findUnique({ where: { date } })) return { ok: false as const, error: "Today is already closed" };
  if (countedCash < 0 || !Number.isFinite(countedCash)) return { ok: false as const, error: "Enter the counted cash amount" };

  const r = await computeReport(parsePeriod({ p: "day" }));
  const expected = r.expectedDrawer;
  const variance = Math.round((countedCash - expected) * 100) / 100;

  await db.dayClose.create({ data: { date, expectedCash: expected, countedCash, variance, note: note?.trim() || null, by: st.id } });
  await audit("Day closed", `${date} · counted ₹${countedCash} vs expected ₹${expected} · variance ₹${variance}`, st.id);
  void notifyOwner(
    `Day closed — ${variance === 0 ? "drawer matches ✓" : `VARIANCE ₹${variance}`}`,
    `${date}: expected ₹${expected}, counted ₹${countedCash}, variance ₹${variance}. Closed by ${st.name}.${note ? ` Note: ${note}` : ""}`,
  );
  return { ok: true as const, expected, variance };
}

export async function todayClose() {
  await requireStaff(1);
  const rec = await db.dayClose.findUnique({ where: { date: istToday() } });
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

  await db.$transaction(async (tx) => {
    await tx.student.update({ where: { id: studentId }, data: { credits: { increment: amount } } });
    await tx.payment.create({ data: { method, amount, collegeId: stu.collegeId, studentId, note: "Wallet top-up" } });
    // appears in the student's wallet ledger as money added
    await tx.compensation.create({ data: { studentId, kind: "topup", amount, method: "credit", comment: `Top-up (${method})`, by: st.id } });
  });
  await audit("Wallet top-up", `${stu.name} · ₹${amount} (${method})`, st.id);
  void notifyOwner("Wallet top-up", `${stu.name} added ₹${amount} by ${method.toUpperCase()} (taken by ${st.name}).`);
  return { ok: true as const };
}
