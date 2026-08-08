/* Give a wash day to students registered before the feature existed.

   Registration assigns one now, and subscribing has a safety net, but a
   student who predates both — and hasn't subscribed — has none. They simply
   see no wash day on their home screen.

   Uses the same load-balancing allocator as registration, so backfilled
   students spread across the week rather than piling onto one day. Only ever
   fills a MISSING day; an existing assignment is never disturbed. */
import "dotenv/config";
import { db } from "../lib/db";
import { assignWashDay } from "../lib/washday-server";
import { WEEKDAY_NAMES } from "../lib/washday";

const DRY = !process.argv.includes("--apply");

async function main() {
  const url = process.env.DATABASE_URL || "";
  console.log("host:", (url.match(/@([^/?]+)/) || [])[1]);
  console.log(DRY ? "mode: DRY RUN (pass --apply to write)\n" : "mode: APPLYING\n");

  const missing = await db.student.findMany({
    where: { washDay: null },
    select: { id: true, name: true, collegeId: true },
  });
  if (!missing.length) { console.log("Every student already has a wash day."); return; }

  console.log(`${missing.length} student(s) without a wash day:`);
  for (const s of missing) {
    if (DRY) { console.log(`  ${s.id}  ${s.name}  → would assign`); continue; }
    await assignWashDay(s.id, s.collegeId);
    const after = await db.student.findUniqueOrThrow({ where: { id: s.id }, select: { washDay: true } });
    console.log(`  ${s.id}  ${s.name}  → ${after.washDay === null ? "FAILED" : WEEKDAY_NAMES[after.washDay]}`);
  }

  if (!DRY) {
    const left = await db.student.count({ where: { washDay: null } });
    console.log(`\n${left === 0 ? "✓ all students now have a wash day" : `✗ ${left} still missing`}`);
    if (left) process.exitCode = 1;
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
