/* One command that checks everything, and reports honestly.

     npm run verify           # everything
     npm run verify -- --fast # skip the slow DB-backed suites

   Written because "is everything OK?" kept being answered by whichever check
   happened to be fresh in mind. Each step below states what it proves, and —
   just as importantly — the summary distinguishes a step that PASSED from one
   that was SKIPPED, so a green run can never quietly mean "we didn't look". */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const FAST = process.argv.includes("--fast");
const hasEnv = existsSync(".env");

/** proves: what a green result actually tells you. */
const STEPS = [
  {
    name: "typecheck",
    /* rimraf .next/dev first: tsconfig includes BOTH .next/types (build) and
       .next/dev/types (dev server). A dev server that ran since the last build
       leaves a LayoutProps global that only knows the routes it lazily
       compiled, and the build's validator then fails against that stale
       constraint — a "type error" caused by having previewed the app, not by
       any code. Cost us a failed verify on 2026-08-23. */
    cmd: "npx rimraf .next/dev && npx tsc --noEmit",
    proves: "no type errors anywhere in the app",
  },
  {
    name: "unit + scenario tests",
    cmd: "npm test",
    proves: "money maths, bag codes, cycle rules, auth guards",
    slow: true,
    needsDb: true,
  },
  {
    name: "build",
    cmd: "npm run build",
    proves: "every route compiles and server/client boundaries hold",
    slow: true,
  },
  {
    name: "backup coverage",
    cmd: "npx tsx scripts/verify-backup.ts",
    proves: "every table is captured by the backup AND readable",
    needsDb: true,
  },
  {
    name: "database integrity",
    cmd: "npx tsx scripts/db-integrity.ts",
    proves: "no orphans, cycle counts agree, invoice numbering has no gaps",
    needsDb: true,
  },
  {
    name: "ledger guards",
    cmd: "npx tsx scripts/verify-guards.ts",
    proves: "payments/invoices genuinely REJECT edits and deletes",
    needsDb: true,
  },
  {
    /* Re-arm the test schema's raw guards before anything asserts on them.
       `prisma db push` drops objects Prisma does not know about — the partial
       unique index on bag codes among them — and the unit suite pushes to
       ff_test as part of its setup. Without this the QA pipeline reports "DB
       refuses to reissue a retired code" as a product failure when the truth
       is that a previous step disarmed the constraint. Cheap, and idempotent. */
    name: "re-arm test-schema guards",
    cmd: "node scripts/ensure-guards.mjs",
    env: { FF_GUARD_SCHEMA: "ff_test" },
    proves: "the isolated test schema carries the same constraints as production",
    needsDb: true,
  },
  {
    name: "full QA pipeline",
    cmd: "npx tsx scripts/qa-pipeline.ts",
    proves: "a whole campus lifecycle end to end against a real database",
    slow: true,
    needsDb: true,
  },
  {
    /* Last, and never a failure. Every setting it lists is correct today; the
       danger is that they are still correct-looking on the day a real student
       signs in. Printing them at the end of every verify keeps the list in
       front of whoever is about to deploy. */
    name: "launch readiness",
    cmd: "node scripts/launch-check.mjs",
    proves: "test-only settings are visible, not forgotten",
  },
];

const results = [];
for (const step of STEPS) {
  if (FAST && step.slow) { results.push({ ...step, status: "skipped", why: "--fast" }); continue; }
  if (step.needsDb && !hasEnv) { results.push({ ...step, status: "skipped", why: "no .env" }); continue; }

  process.stdout.write(`\n▶ ${step.name} — ${step.proves}\n`);
  const started = Date.now();
  const r = spawnSync(step.cmd, {
    shell: true,
    stdio: "inherit",
    // step.env lets a step target the test schema without affecting the rest
    env: step.env ? { ...process.env, ...step.env } : process.env,
  });
  const secs = Math.round((Date.now() - started) / 1000);
  results.push({ ...step, status: r.status === 0 ? "passed" : "FAILED", secs });
}

console.log("\n" + "═".repeat(64));
let failed = 0, skipped = 0;
for (const r of results) {
  const mark = r.status === "passed" ? "✓" : r.status === "skipped" ? "–" : "✗";
  const detail = r.status === "skipped" ? `skipped (${r.why})` : `${r.status}${r.secs ? ` in ${r.secs}s` : ""}`;
  if (r.status === "FAILED") failed++;
  if (r.status === "skipped") skipped++;
  console.log(`${mark} ${r.name.padEnd(24)} ${detail}`);
}
console.log("═".repeat(64));

if (failed) {
  console.log(`${failed} step(s) FAILED — do not deploy.`);
  process.exit(1);
}
if (skipped) {
  // A pass that skipped half the checks is not the same as a pass.
  console.log(`All run steps passed, but ${skipped} were SKIPPED — this is not a full green.`);
  process.exit(0);
}
console.log("Everything passed. Safe to deploy.");
