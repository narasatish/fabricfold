"use server";
/* Daily cash count: the owner/admin counts the drawer at the end of the day and
   records it. The app's expected figure comes from the same computeReport() the
   daily email uses, so the two can't disagree. Records the count only; no money
   row is created or changed. One count per campus per day (re-counting replaces it). */
import { db } from "../db";
import { requireStaff, assertSameCollege } from "../auth";
import { computeReport, parsePeriod } from "../report";
import { istDateStr } from "../slots";
import { audit } from "../notify";

export async function recordCashCount(collegeId: string, counted: number) {
  const st = await requireStaff(3); // Admin+
  assertSameCollege(st, collegeId);
  if (!Number.isFinite(counted) || counted < 0 || counted > 10_000_000) {
    return { ok: false as const, error: "Enter the amount you counted in the drawer" };
  }
  const day = istDateStr(Date.now());
  const report = await computeReport(parsePeriod({ p: "day" }), collegeId);
  const expected = Math.round(Number(report.expectedDrawer));
  const counts = Math.round(counted);
  const diff = counts - expected;
  await db.dayCashCount.upsert({
    where: { collegeId_day: { collegeId, day } },
    create: { collegeId, day, expectedCash: expected, countedCash: counts, diff, staffId: st.id },
    update: { expectedCash: expected, countedCash: counts, diff, staffId: st.id },
  });
  await audit("Cash count", `${day}: counted ₹${counts}, expected ₹${expected}, difference ₹${diff}`, st.id);
  return { ok: true as const, expected, counted: counts, diff };
}
