/* Wash-day distribution per campus, and whether a closed day is declared.
   The allocator only avoids a closed day if the campus actually has one set —
   otherwise it will happily assign Sundays. Read-only. */
import "dotenv/config";
import { db } from "../lib/db";
import { WEEKDAY_NAMES } from "../lib/washday";

async function main() {
  const colleges = await db.college.findMany({ select: { id: true, name: true, closedWeekday: true } });
  for (const c of colleges) {
    const studs = await db.student.findMany({ where: { collegeId: c.id }, select: { washDay: true } });
    if (!studs.length) continue;
    const counts = new Array(7).fill(0);
    for (const s of studs) if (s.washDay !== null) counts[s.washDay]++;
    console.log(`\n${c.name}  (${studs.length} students)`);
    console.log(`  closed day: ${c.closedWeekday === null ? "NOT SET — Sundays will be assigned" : WEEKDAY_NAMES[c.closedWeekday]}`);
    console.log("  " + counts.map((n, i) => `${WEEKDAY_NAMES[i].slice(0, 3)} ${n}`).join("   "));
    if (c.closedWeekday !== null && counts[c.closedWeekday] > 0) {
      console.log(`  ✗ ${counts[c.closedWeekday]} student(s) assigned to the CLOSED day`);
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
