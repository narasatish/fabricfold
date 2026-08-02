/* Create (or update) the three St Mary's subscription tiers.

   Idempotent: matches on college + plan name, so re-running edits the existing
   plan instead of creating duplicates. Never touches a student's live
   subscription — those hold their own snapshot of buckets/cycles.

   Run:  npx tsx scripts/create-stmarys-plans.ts
   Point DATABASE_URL at the environment you actually mean to change. */
import "dotenv/config";
import { PrismaClient } from "../lib/generated/prisma/client";

const url = process.env.DATABASE_URL || "file:./dev.db";
function makeAdapter() {
  if (/^postgres(ql)?:\/\//.test(url)) {
    const { PrismaPg } = require("@prisma/adapter-pg");
    return new PrismaPg({ connectionString: url });
  }
  const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");
  return new PrismaBetterSqlite3({ url });
}
const db = new PrismaClient({ adapter: makeAdapter() });

const COLLEGE_NAME = "St Mary's";
const KG_PER_CYCLE = 7;

/* Is the headline price the FINAL amount a student pays?
   true  -> ₹5,000 is what they hand over, no GST added, no tax invoice
   false -> ₹5,000 + GST% is collected, tax invoice raised on UPI
   Flip this to match how the tiers are advertised on campus. */
const GST_FREE = false;

const TIERS = [
  { tier: "bronze", name: "Bronze", price: 4000, buckets: [{ service: "washFold", cycles: 34, kgPerCycle: KG_PER_CYCLE }] },
  { tier: "silver", name: "Silver", price: 5000, buckets: [
      { service: "washFold", cycles: 20, kgPerCycle: KG_PER_CYCLE },
      { service: "washIron", cycles: 14, kgPerCycle: KG_PER_CYCLE },
    ] },
  { tier: "gold", name: "Gold", price: 6000, buckets: [{ service: "washIron", cycles: 34, kgPerCycle: KG_PER_CYCLE }] },
];

async function main() {
  const college = await db.college.findFirst({ where: { name: COLLEGE_NAME } });
  if (!college) throw new Error(`No college named "${COLLEGE_NAME}" — check the DB you're pointed at.`);

  console.log(`Target: ${url.replace(/:\/\/[^@]*@/, "://***@")}`);
  console.log(`College: ${college.name} (${college.id})\n`);

  for (const t of TIERS) {
    const cycles = t.buckets.reduce((s, b) => s + b.cycles, 0);
    const existing = await db.plan.findFirst({ where: { collegeId: college.id, name: t.name } });
    const data = { tier: t.tier, price: t.price, gstFree: GST_FREE, active: true, buckets: t.buckets };

    const plan = existing
      ? await db.plan.update({ where: { id: existing.id }, data })
      : await db.plan.create({ data: { ...data, collegeId: college.id, name: t.name } });

    const mix = t.buckets.map((b) => `${b.cycles}× ${b.service}`).join(" + ");
    console.log(`${existing ? "updated" : "created"}  ${t.name.padEnd(7)} ₹${t.price}  ${cycles} cycles  (${mix})  id=${plan.id}`);
  }

  console.log(`\nGST: ${GST_FREE ? "not added (price is final)" : "added on top of the price"}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
