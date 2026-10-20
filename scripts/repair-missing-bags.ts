/* One-time repair for the 2026-10-20 bug: a St Mary's student could end up
   with an ACTIVE, paid Subscription and zero Bag rows, because
   registerStudent's bag-issuance used to be a separate, best-effort step
   AFTER the subscription had already committed, with its failure swallowed
   into a toast nobody was forced to act on. Fixed at the source — see
   lib/plan-activation.ts's `firstBag` param and docs/claude-playbook.md's
   2026-10-20 entry — but that fix does nothing for students who already
   hit the gap before it landed. This script finds and repairs those.

   For each affected student: mint them the correct tier-lettered bag code
   via the SAME allocateBagCode() the rest of the app uses, create the Bag
   row, audit-log it, and tell the student their real customer ID — mirroring
   exactly what registerStudent does for a normal successful registration,
   so a repaired student is indistinguishable from one that worked the first
   time.

   Dry-run by default. Pass --apply to actually write. Processes students
   ONE AT A TIME (not a single bulk transaction) because allocateBagCode
   needs to see each previous mint before allocating the next — the same
   constraint live counter traffic has. */
import "dotenv/config";
import { db } from "../lib/db";
import { allocateBagCode, bagKindFor, type BagKind } from "../lib/bagcode";
import { audit, pushNotif } from "../lib/notify";

const APPLY = process.argv.includes("--apply");

async function main() {
  const url = process.env.DATABASE_URL || "";
  console.log("host:", (url.match(/@([^/?]+)/) || [])[1], APPLY ? "(APPLYING)" : "(dry run — pass --apply to write)");

  const subs = await db.subscription.findMany({
    where: { active: true },
    include: { planRef: true, student: { include: { college: true, bags: { select: { id: true } } } } },
  });
  const affected = subs.filter((s) => s.student.bags.length === 0);

  if (!affected.length) {
    console.log("\nNo affected students found — nothing to repair.");
    return;
  }

  console.log(`\nFound ${affected.length} student(s) with an active subscription and zero bags:\n`);
  for (const s of affected) {
    console.log(`  ${s.student.id}  ${s.student.name}  ${s.student.college.name}  plan=${s.plan}  tier=${s.planRef?.tier ?? "?"}`);
  }

  if (!APPLY) {
    console.log("\nDry run only — no changes made. Re-run with --apply to mint their bags.");
    return;
  }

  console.log("\nMinting bags...\n");
  for (const s of affected) {
    const kind: BagKind = s.student.kind === "faculty" ? "faculty"
      : s.student.college.name.trim().toUpperCase() === "BVRIT" ? "bvrit"
      : bagKindFor(s.planRef?.tier ?? null);

    // Same advisory lock key issueBag/customerIdFor's self-heal use, and the
    // same fresh re-check — the worklist above was computed once, up front;
    // re-checking here guards against staff manually issuing a bag for one
    // of these students (or this script being run twice) while this loop is
    // still working through the rest of the list.
    const code = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bag-issue|${s.student.id}`}))`;
      const already = await tx.bag.findFirst({ where: { studentId: s.student.id, status: "active" }, select: { code: true } });
      if (already) return already.code;
      const c = await allocateBagCode(tx, kind);
      await tx.bag.create({
        data: {
          code: c, studentId: s.student.id, tier: kind === "bronze" || kind === "silver" || kind === "gold" ? kind : null,
          complimentary: true, issuedBy: "system",
          note: "repair: active subscription had no bag — minted retroactively (2026-10-20)",
          status: "active",
        },
      });
      return c;
    }, { timeout: 15_000 });

    await audit("Bag issued (repair)", `${code} · ${s.student.name} · retroactive fix for a subscription with no bag`, "system");
    await pushNotif(s.student.id, `Your FabricFold customer ID is ${code}. Sorry for the delay — show this at the counter.`, "status").catch(() => {});
    console.log(`  ${s.student.id}  ${s.student.name}  ->  ${code}`);
  }

  console.log(`\nDone — ${affected.length} student(s) repaired.`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
