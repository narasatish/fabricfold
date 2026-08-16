/* Registration lockdown tests.

   Students must NOT be able to create their own account. A student account
   can only be created by staff (registerStudent). An unrecognised customer
   phone number verifying an OTP must be turned away, not offered a signup
   form â€” and a student's phone number can only be changed by an Admin+
   (updateStudentPhone), never by the student themselves.

   NOTE on scope: registerStudent/updateStudentPhone both call requireStaff(),
   which reads the session from next/headers cookies() â€” that throws "Not
   signed in" outside a real Next.js request, so it can't be driven end-to-end
   from a plain vitest run (the same reason the existing money.test.ts never
   calls session-gated actions directly, only pure money functions). Those two
   guarded here with a source-level check instead: it fails loudly if the
   required role is ever loosened, without pretending to exercise a session
   that doesn't exist in this harness. */
import "dotenv/config";
import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { ensureTestSchema } from "./_schema";
import path from "node:path";
import fs from "node:fs";

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_URL = IS_PG ? BASE.split("?")[0] + "?schema=ff_test" : "file:" + path.resolve(__dirname, "../test.db");
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/actions/auth");

const NEW_NUMBER = "9812345670"; // never registered

/** Is the test schema already in step with the Prisma schema?
 *  Probed by touching the newest model â€” a query that succeeds means the table
 *  exists, and a failure means the schema predates it and needs a push. Cheap
 *  and, unlike a version file, it cannot drift out of date on its own. */
async function schemaIsCurrent(): Promise<boolean> {
  try {
    await db.sheetOutbox.count();
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  db = (await import("../lib/db")).db;

  /* Push ONLY when the test schema is actually behind.
     This hook is the one place in the suite that runs DDL, and it used to do
     so on every run. Two costs, both real:

       - `prisma db push` drops objects Prisma does not know about, including
         the partial unique index that stops two students sharing a bag code.
         The QA pipeline then reported "DB refuses to reissue a retired code"
         as a product failure when this line had quietly disarmed it.
       - the DDL runs while other files are hitting the same database, and
         intermittently took unrelated tests down with it â€” otp-security has
         failed this way, on a schema change that had nothing to do with OTPs.

     So: probe for the newest model first and skip the push when it is there,
     which is the normal case. A fresh or stale schema still self-heals, and
     the guards are re-armed only on the path that could have removed them. */
  await ensureTestSchema(TEST_URL, schemaIsCurrent, IS_PG);

  auth = await import("../lib/actions/auth");

  await db.college.upsert({
    where: { id: "reg-test-college" }, update: {},
    create: { id: "reg-test-college", name: "Reg Test College", features: {} },
  });
  // `prisma db push` against a remote Postgres is the slow part, and it grows
  // with the schema â€” 120s was already marginal and broke once the Bag table
  // landed. Kept generous on purpose: this hook is setup, not a perf budget.
}, 300_000);

afterEach(async () => {
  await db.otp.deleteMany({ where: {} });
  await db.student.deleteMany({ where: { phone: NEW_NUMBER } });
});

async function mkOtp(phone: string) {
  const code = "111111";
  await db.otp.create({ data: { phone, purpose: "login", code, expiresAt: new Date(Date.now() + 300_000) } });
  return code;
}

describe("students cannot self-register", () => {
  it("an unrecognised customer number is rejected, not offered a signup form", async () => {
    const code = await mkOtp(NEW_NUMBER);
    const r = await auth.verifyOtp(NEW_NUMBER, code, "customer");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/isn't registered/i);
    // Crucially, no student row was created as a side effect.
    expect(await db.student.findUnique({ where: { phone: NEW_NUMBER } })).toBeNull();
  });

  it("passing a name/collegeId payload (the old registration shape) does NOT create an account", async () => {
    const code = await mkOtp(NEW_NUMBER);
    // The 4th param is kept in the signature for stale client bundles, but the
    // server ignores it for registration purposes â€” this call shape is
    // type-valid, it just must not actually create an account.
    const r = await auth.verifyOtp(NEW_NUMBER, code, "customer", { name: "Sneaky", collegeId: "reg-test-college" });
    expect(r.ok).toBe(false);
    expect(await db.student.findUnique({ where: { phone: NEW_NUMBER } })).toBeNull();
  });

  // NOTE: a full successful login also isn't testable here â€” verifyOtp calls
  // createSession(), which needs next/headers cookies() same as requireStaff,
  // so it throws outside a real request regardless of this feature. The two
  // tests above already prove the lockdown property (the only thing this
  // change actually altered); the success path is unchanged legacy behaviour.
});

describe("registration & phone changes are staff-gated (source-level regression guard)", () => {
  const adminSrc = fs.readFileSync(path.resolve(__dirname, "../lib/actions/admin.ts"), "utf8");

  it("registerStudent requires a staff session (requireStaff) â€” any role, but never self-serve", () => {
    const fn = adminSrc.slice(adminSrc.indexOf("export async function registerStudent"));
    expect(fn.slice(0, 200)).toMatch(/requireStaff\(1\)/);
  });

  it("updateStudentPhone requires Admin+ (role 3), not just any staff", () => {
    const fn = adminSrc.slice(adminSrc.indexOf("export async function updateStudentPhone"));
    expect(fn.slice(0, 200)).toMatch(/requireStaff\(3\)/);
  });

  it("updateStudentPhone rejects a number already used by a different student", () => {
    const fn = adminSrc.slice(adminSrc.indexOf("export async function updateStudentPhone"), adminSrc.indexOf("export async function updateStudentPhone") + 800);
    expect(fn).toMatch(/already registered to another student/);
  });
});
