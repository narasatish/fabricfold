/* Launch readiness — the settings that are fine today and dangerous with real
   students on the system.

   These are deliberately NOT failures. Every one of them is the correct
   setting right now: SMS is not live, so the OTP viewer is the only way to
   test a login. The risk is not that they are on, it is that they are still on
   the day the first real student signs in, and nothing anywhere says so.

   Run:  node scripts/launch-check.mjs
   Also runs as the last step of `npm run verify`. */
import "dotenv/config";

const RISKS = [
  {
    on: () => process.env.TEST_TOOLS === "on",
    name: "TEST_TOOLS=on",
    means: "the Owner can read any pending login OTP from the Admin screen, and simulate payments",
    fix: "vercel env rm TEST_TOOLS production   (then redeploy)",
    whyNow: "the only way to test a login while SMS is not delivering",
  },
  {
    on: () => !!process.env.TEST_PHONES,
    name: `TEST_PHONES=${process.env.TEST_PHONES || ""}`,
    means: "those numbers sign in with the fixed DEV_OTP code instead of a texted one",
    fix: "vercel env rm TEST_PHONES production   (then redeploy)",
    whyNow: "your demo accounts depend on it",
  },
  {
    on: () => !!process.env.DEV_OTP,
    name: "DEV_OTP is set",
    means: "a fixed code exists; it is honoured ONLY for TEST_PHONES in production, but removing both is cleaner",
    fix: "vercel env rm DEV_OTP production",
    whyNow: "pairs with TEST_PHONES above",
  },
  {
    on: () => process.env.SMS_DRY_RUN === "1",
    name: "SMS_DRY_RUN=1",
    means: "the app BEHAVES as though texts are sending but nothing leaves the building",
    fix: "vercel env rm SMS_DRY_RUN production",
    whyNow: "lets the OTP flow be exercised without a provider",
  },
];

const live = RISKS.filter((r) => r.on());

console.log("\n── launch readiness");
if (!live.length) {
  console.log("  no test-only settings detected in this environment.");
} else {
  console.log(`  ${live.length} test-only setting(s) active. Correct for now — MUST be off before real students:\n`);
  for (const r of live) {
    console.log(`  • ${r.name}`);
    console.log(`      does:  ${r.means}`);
    console.log(`      kept:  ${r.whyNow}`);
    console.log(`      off:   ${r.fix}\n`);
  }
}

/* Things that cannot be checked from here but belong on the same list, so the
   whole set lives in one place rather than in someone's memory. */
console.log("  Also before launch, and not checkable from this machine:");
console.log("    • Twilio upgraded — until then no student receives an OTP, order ID or complaint photo");
console.log("    • /api/sheets/flush on an external scheduler (cron-job.org), as the net under after()");
console.log("    • the app connecting as a restricted DB role, not the owner (scripts/create-app-role.sql)");
console.log("    • point-in-time recovery enabled (Supabase Pro)\n");

// Never fails the build: this is a reminder, not a gate.
process.exit(0);
