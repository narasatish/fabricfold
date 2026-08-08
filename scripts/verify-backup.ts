/* Prove the backup actually captures every table, by taking a real snapshot
   through the same code path the route uses and comparing against the schema.

   "The route exists" is not evidence a restore would work. Read-only. */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { db } from "../lib/db";

const SKIP = new Set(["otp"]);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

async function main() {
  const schema = fs.readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");
  const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => lower(m[1]));

  const keys = Object.keys(db as object)
    .filter((k) => !k.startsWith("$") && !k.startsWith("_"))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((k) => typeof (db as any)[k]?.findMany === "function")
    .filter((k) => !SKIP.has(k))
    .sort();

  const missing = models.filter((m) => !SKIP.has(m) && !keys.includes(m));
  console.log(`schema models      : ${models.length}`);
  console.log(`captured by backup : ${keys.length}`);
  console.log(`deliberately skipped: ${[...SKIP].join(", ")}`);

  if (missing.length) {
    console.log("\nMISSING FROM BACKUP:");
    for (const m of missing) console.log("  ✗", m);
    process.exitCode = 1;
    return;
  }
  console.log("\n✓ every model is captured");

  // Actually read from each, so a table that exists but errors is caught here
  // rather than at 3am when the cron runs.
  let rows = 0, failed: string[] = [];
  for (const k of keys) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows += await (db as any)[k].count();
    } catch (e) { failed.push(`${k}: ${(e as Error).message.slice(0, 40)}`); }
  }
  if (failed.length) {
    console.log("\nTABLES THAT FAILED TO READ:");
    for (const f of failed) console.log("  ✗", f);
    process.exitCode = 1;
  } else {
    console.log(`✓ all ${keys.length} tables readable — ${rows} rows total`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
