/* Wash-day allocation — server-only, DB-touching logic. Import from here in
   server actions/pages only (never from a "use client" component — use the
   pure helpers in lib/washday.ts there instead). */
import { db } from "./db";

/** Pick the least-loaded open weekday for this college and assign it to the student. */
export async function assignWashDay(studentId: string, collegeId: string): Promise<number> {
  const college = await db.college.findUnique({ where: { id: collegeId }, select: { closedWeekday: true } });
  const closed = college?.closedWeekday ?? null;

  const counts = await db.student.groupBy({
    by: ["washDay"],
    where: { collegeId, washDay: { not: null } },
    _count: true,
  });
  const load = new Map<number, number>();
  for (let d = 0; d < 7; d++) if (d !== closed) load.set(d, 0);
  for (const c of counts) if (c.washDay !== null && load.has(c.washDay)) load.set(c.washDay, c._count);

  let best = closed === 0 ? 1 : 0; // any open day as a starting default
  let bestCount = Infinity;
  for (const [day, n] of load) {
    if (n < bestCount) { best = day; bestCount = n; }
  }

  await db.student.update({ where: { id: studentId }, data: { washDay: best } });
  return best;
}

/** Distribution of assigned wash days for a college — for the Admin dashboard. */
export async function washDayDistribution(collegeId: string) {
  const counts = await db.student.groupBy({
    by: ["washDay"],
    where: { collegeId, washDay: { not: null } },
    _count: true,
  });
  const byDay = new Array(7).fill(0);
  for (const c of counts) if (c.washDay !== null) byDay[c.washDay] = c._count;
  return byDay;
}
