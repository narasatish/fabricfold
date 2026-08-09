/* Set the weekly closed day for every campus, and move anyone already assigned
   to it onto an open day.

   Setting the flag alone isn't enough: students allocated before the closed day
   existed keep pointing at it, and would be told to come in on a day the
   counter is shut. Reassignment uses the same load-balancing allocator, so they
   land on the least-busy open day rather than all piling onto one.

   Dry-run by default; pass --apply to write. */
import "dotenv/config";
import { db } from "../lib/db";
import { assignWashDay } from "../lib/washday-server";
import { WEEKDAY_NAMES } from "../lib/washday";

const CLOSED = 4; // 0=Sun .. 4=Thursday
const DRY = !process.argv.includes("--apply");

async function main() {
  const url = process.env.DATABASE_URL || "";
  console.log("host:", (url.match(/@([^/?]+)/) || [])[1]);
  console.log(`closed day: ${WEEKDAY_NAMES[CLOSED]}`);
  console.log(DRY ? "mode: DRY RUN (pass --apply to write)\n" : "mode: APPLYING\n");

  const colleges = await db.college.findMany({ select: { id: true, name: true, closedWeekday: true } });
  for (const c of colleges) {
    const stuck = await db.student.findMany({
      where: { collegeId: c.id, washDay: CLOSED },
      select: { id: true, name: true },
    });
    console.log(`${c.name}: closedWeekday ${c.closedWeekday ?? "unset"} → ${CLOSED}, ${stuck.length} student(s) to move`);
    if (DRY) continue;

    await db.college.update({ where: { id: c.id }, data: { closedWeekday: CLOSED } });
    for (const s of stuck) {
      // clear first so the allocator treats them as unassigned and rebalances
      await db.student.update({ where: { id: s.id }, data: { washDay: null } });
      await assignWashDay(s.id, c.id);
      const after = await db.student.findUniqueOrThrow({ where: { id: s.id }, select: { washDay: true } });
      console.log(`   ${s.name} → ${after.washDay === null ? "FAILED" : WEEKDAY_NAMES[after.washDay]}`);
    }
  }

  if (!DRY) {
    const left = await db.student.count({ where: { washDay: CLOSED } });
    console.log(`\n${left === 0 ? "✓ nobody is on the closed day" : `✗ ${left} still on ${WEEKDAY_NAMES[CLOSED]}`}`);
    if (left) process.exitCode = 1;
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
