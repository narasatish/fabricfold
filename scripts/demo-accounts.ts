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
   Env:  DEMO_COLLEGE (campus name, defaults to St Mary's) */
import "dotenv/config";
import { db } from "../lib/db";
import { assignWashDay } from "../lib/washday-server";

/* The accounts to create. Kept in the file rather than env vars because these
   are a fixed, reviewable list — you can see at a glance exactly who gets an
   account and at what level, which matters when one of them can take money. */
const STUDENTS = [
  { phone: "7799661888", name: "Demo Student 1" },
  { phone: "6303972660", name: "Demo Student 2" },
];

/* Roles: 1 Counter · 2 Manager · 3 Admin · 4 Owner.
   8019121966 is the Owner and already exists — listed so the script reports
   it, but an existing staff member's role is NEVER changed here. Silently
   promoting or demoting someone from a seeding script is how an account ends
   up with permissions nobody remembers granting. */
const STAFF = [
  { phone: "8019121966", name: "Owner", role: 4 },
  { phone: "9381232723", name: "Demo Admin", role: 3 },
];

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

  // A demo account is a REAL account: the students can place orders, the admin
  // can take money. Requiring the allowlist means one can never be created for
  // a number that isn't already yours to test with.
  const allowed = allowlisted();
  const wanted = [...STUDENTS.map((s) => s.phone), ...STAFF.map((s) => s.phone)];
  const missing = wanted.filter((p) => !allowed.includes(p));
  if (missing.length) {
    console.error(
      [
        `Refusing: ${missing.join(", ")} not in TEST_PHONES.`,
        "Add them there first — TEST_PHONES is what limits the fixed DEV_OTP to",
        "numbers you control, so an account outside it could be signed into by",
        "whoever holds that number.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const college = await db.college.findFirst({ where: { name: COLLEGE_NAME } });
  if (!college) {
    console.error(`No college named "${COLLEGE_NAME}". Set DEMO_COLLEGE to an existing campus.`);
    process.exit(1);
  }
  console.log("campus:", college.name, "\n");

  for (const spec of STUDENTS) {
    let stu = await db.student.findUnique({ where: { phone: spec.phone } });
    if (stu) {
      console.log(`student  existing  ${stu.id}  ${stu.name}  +91 ${stu.phone}`);
    } else {
      let id = "";
      for (let i = 0; i < 20; i++) {
        id = String(Math.floor(100000 + Math.random() * 900000));
        if (!(await db.student.findUnique({ where: { id } }))) break;
      }
      stu = await db.student.create({ data: { id, phone: spec.phone, name: spec.name, collegeId: college.id } });
      console.log(`student  created   ${stu.id}  ${stu.name}  +91 ${stu.phone}`);
    }
    if (stu.washDay === null) {
      await assignWashDay(stu.id, college.id);
      const after = await db.student.findUniqueOrThrow({ where: { id: stu.id } });
      console.log(`         wash day  ${after.washDay}`);
    }
  }

  for (const spec of STAFF) {
    const existing = await db.staff.findUnique({ where: { phone: spec.phone } });
    if (existing) {
      const note = existing.role === spec.role ? "" : `  (role is ${existing.role}, left as-is)`;
      console.log(`staff    existing  ${existing.name}  role ${existing.role}  +91 ${existing.phone}${note}`);
    } else {
      const st = await db.staff.create({ data: { phone: spec.phone, name: spec.name, role: spec.role, collegeId: college.id } });
      console.log(`staff    created   ${st.name}  role ${st.role}  +91 ${st.phone}`);
    }
  }

  console.log(
    [
      "",
      "Sign in at /login — students under Customer, staff under Staff.",
      "Plans and bags are deliberately NOT pre-created: assigning them at the",
      "counter is the part worth testing.",
    ].join("\n"),
  );
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
