/* Create demo accounts for testing the real login flow.

   Unlike the QA scripts, this DOES write to the live `public` schema — demo
   accounts only prove anything if you can actually sign into them. So it is
   deliberately conservative:

   - Idempotent: matches on phone number, so re-running updates rather than
     duplicating.
   - Additive: never deletes, never touches a student it did not create.
   - Refuses to run unless the numbers are in TEST_PHONES, so a demo account
     can only ever exist for a number you have explicitly allowlisted.
   - Prints exactly what it made, so you know what to remove later.

   These accounts are REAL. A demo student can place real orders and a demo
   admin can take real money. Remove them before launch, or keep them on
   numbers only you control.

   Run:  npx tsx scripts/demo-accounts.ts
   Env:  DEMO_STUDENT_PHONE, DEMO_ADMIN_PHONE, DEMO_COLLEGE (name) */
import "dotenv/config";
import { db } from "../lib/db";
import { assignWashDay } from "../lib/washday-server";

const STUDENT_PHONE = (process.env.DEMO_STUDENT_PHONE || "").replace(/\D/g, "").slice(-10);
const ADMIN_PHONE = (process.env.DEMO_ADMIN_PHONE || "").replace(/\D/g, "").slice(-10);
const COLLEGE_NAME = process.env.DEMO_COLLEGE || "St Mary's";

function allowlisted() {
  return (process.env.TEST_PHONES || "")
    .split(",")
    .map((p) => p.replace(/\D/g, "").slice(-10))
    .filter((p) => p.length === 10);
}

async function main() {
  const url = process.env.DATABASE_URL || "";
  console.log("target:", (url.match(/@([^/?]+)/) || [])[1] || "unknown");

  if (STUDENT_PHONE.length !== 10 || ADMIN_PHONE.length !== 10) {
    console.error("Set DEMO_STUDENT_PHONE and DEMO_ADMIN_PHONE to 10-digit numbers.");
    process.exit(1);
  }

  // A demo account is a real account. Requiring the allowlist means one can
  // never be created for a number that isn't already yours to test with.
  const allowed = allowlisted();
  const missing = [STUDENT_PHONE, ADMIN_PHONE].filter((p) => !allowed.includes(p));
  if (missing.length) {
    console.error(
      `Refusing: ${missing.join(", ")} not in TEST_PHONES.\n` +
        `Add them there first — it's what limits the fixed DEV_OTP to numbers you control.`,
    );
    process.exit(1);
  }

  const college = await db.college.findFirst({ where: { name: COLLEGE_NAME } });
  if (!college) {
    console.error(`No college named "${COLLEGE_NAME}". Set DEMO_COLLEGE to an existing campus.`);
    process.exit(1);
  }

  // ── Demo student ────────────────────────────────────────────────
  let student = await db.student.findUnique({ where: { phone: STUDENT_PHONE } });
  if (student) {
    console.log(`student  existing  ${student.id}  ${student.name}`);
  } else {
    let id = "";
    for (let i = 0; i < 20; i++) {
      id = String(Math.floor(100000 + Math.random() * 900000));
      if (!(await db.student.findUnique({ where: { id } }))) break;
    }
    student = await db.student.create({
      data: { id, phone: STUDENT_PHONE, name: "Demo Student", collegeId: college.id },
    });
    console.log(`student  created   ${student.id}  ${student.name}`);
  }
  if (student.washDay === null) {
    await assignWashDay(student.id, college.id);
    console.log("         wash day assigned");
  }

  // ── Demo admin (role 3: everything except Owner-only tools) ──────
  const existingStaff = await db.staff.findUnique({ where: { phone: ADMIN_PHONE } });
  if (existingStaff) {
    console.log(`admin    existing  ${existingStaff.name}  role ${existingStaff.role}`);
  } else {
    const staff = await db.staff.create({
      data: { phone: ADMIN_PHONE, name: "Demo Admin", role: 3, collegeId: college.id },
    });
    console.log(`admin    created   ${staff.name}  role ${staff.role} (Admin)`);
  }

  const after = await db.student.findUniqueOrThrow({ where: { id: student.id }, include: { subscription: true, bags: true } });
  console.log("\nDemo student state:");
  console.log("  id        ", after.id);
  console.log("  phone     ", "+91 " + after.phone);
  console.log("  wash day  ", after.washDay ?? "—");
  console.log("  plan      ", after.subscription?.active ? after.subscription.plan : "none (assign at the counter)");
  console.log("  bag       ", after.bags.find((b) => b.status === "active")?.code ?? "none (issue at the counter)");
  console.log(
    "\nSign in at /login with these numbers. The plan and bag are deliberately NOT\n" +
      "pre-created — walking through assigning them is the part worth testing.",
  );
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
