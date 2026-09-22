/* Read-only diagnostic: find bag codes whose NUMBER repeats under a
   different letter (e.g. B1003 and G1003 both existing) — the shared
   FySequence numbering scheme (lib/bagcode.ts) depends on a number never
   being reused across letters, so any hit here is a real conflict that
   needs a human decision (which student keeps the number, who gets a new
   one printed), not an automated fix.

   Makes NO writes. Safe to run against production with a read-only or
   normal connection string.

   Usage: DATABASE_URL="postgresql://...?schema=..." node scripts/find-duplicate-bag-numbers.mjs
   (falls back to .env / .env.local's DATABASE_URL if not passed inline) */
/* override:false (the default) here is deliberate: a DATABASE_URL already
   set in the shell (e.g. a real production string, passed inline) must win
   over .env.local's dev database — override:true silently discarded an
   explicitly-provided production URL the first time this ran, and the
   "diagnostic" quietly reported the LOCAL dev database's conflicts instead
   without any error. */
import "dotenv/config";
try { const dotenv = await import("dotenv"); dotenv.config({ path: ".env.local" }); } catch {}

import pg from "pg";

const url = (process.env.DIRECT_URL || process.env.DATABASE_URL || "").split("?")[0];
const schema = new URL(process.env.DIRECT_URL || process.env.DATABASE_URL || "postgresql://x").searchParams.get("schema") || "public";
if (!url) { console.error("No DATABASE_URL/DIRECT_URL set."); process.exit(1); }

const client = new pg.Client({ connectionString: url });
await client.connect();

const { rows } = await client.query(
  `SELECT b.code, b."studentId", s.name, s.phone, s."collegeId", c.name AS college
   FROM "${schema}"."Bag" b
   JOIN "${schema}"."Student" s ON s.id = b."studentId"
   LEFT JOIN "${schema}"."College" c ON c.id = s."collegeId"
   WHERE b.status != 'released'`
);

const byNumber = new Map();
for (const r of rows) {
  const m = /^([BSGWFV])(\d{3,4})$/.exec(r.code);
  if (!m) continue;
  const n = Number(m[2]);
  if (!byNumber.has(n)) byNumber.set(n, []);
  byNumber.get(n).push(r);
}

const conflicts = [...byNumber.entries()].filter(([, list]) => list.length > 1);

if (!conflicts.length) {
  console.log("No number conflicts found — every active bag's number is unique across every letter.");
} else {
  console.log(`Found ${conflicts.length} number(s) shared by more than one active bag:\n`);
  for (const [n, list] of conflicts.sort((a, b) => a[0] - b[0])) {
    console.log(`Number ${n}:`);
    for (const r of list) {
      console.log(`  ${r.code} — ${r.name} (+91 ${r.phone}) · ${r.college || r.collegeId} · student id ${r.studentId}`);
    }
    console.log("");
  }
  console.log(
    "Each group above needs a human decision: which student keeps the number as-is, and which\n" +
    "one(s) get a new number via 'Change ID' in their staff profile page (Admin+, sets a fresh,\n" +
    "not-yet-used code — the app now refuses a number collision going forward, so picking any\n" +
    "free number here is safe). This script makes no changes.",
  );
}

await client.end();
