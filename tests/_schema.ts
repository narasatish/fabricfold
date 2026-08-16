/* Bring the test schema up to date — at most once, and only when needed.

   Five test files used to run `npx prisma db push` in their own beforeAll, and
   vitest runs files in PARALLEL. So up to five schema migrations executed at
   once against the same database. Three separate symptoms came from that, and
   each looked like a different bug:

     - "Command failed: npx prisma db push" — two pushes colliding, taking a
       whole file's tests down with them.
     - otp-security failing with "no code stored" — its inserts landing while
       another file was mid-DDL.
     - the QA pipeline reporting "DB refuses to reissue a retired code" — a
       push had dropped the partial unique indexes, which Prisma does not know
       about and silently removes.

   None of those were product bugs, and all of them were intermittent, which is
   the worst kind: a suite you learn to re-run instead of believe.

   The fix is to make the push CONDITIONAL. In steady state the schema is
   already current, the probe is one cheap query, and no DDL runs at all — so
   there is nothing to collide. A push happens only on the first run after a
   schema change, and the guards are re-armed straight afterwards because that
   push will have removed them. */
import { execSync } from "node:child_process";

let done: Promise<void> | null = null;

/**
 * @param testUrl  DATABASE_URL for the isolated schema
 * @param probe    resolves true when the schema already has the newest model
 * @param isPg     sqlite has no raw guards to re-arm
 */
export function ensureTestSchema(testUrl: string, probe: () => Promise<boolean>, isPg = true): Promise<void> {
  // one attempt per worker process, however many files ask for it
  done ??= (async () => {
    if (await probe()) return;

    execSync("npx prisma db push", { env: { ...process.env, DATABASE_URL: testUrl }, stdio: "ignore" });

    /* Raw objects are not in the Prisma schema, so the push just dropped them:
       the bag-code, payment and order-idempotency indexes. Put them back before
       any test asserts that a duplicate is refused. */
    if (isPg) {
      execSync("node scripts/ensure-guards.mjs", {
        env: { ...process.env, FF_GUARD_SCHEMA: "ff_test" },
        stdio: "ignore",
      });
    }
  })();
  return done;
}
