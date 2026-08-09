/* Take a snapshot through the same logic the backup route uses, and write it
   to a file — so a restore can be tested without going through HTTP auth. */
import "dotenv/config";
import fs from "node:fs";
import { db } from "../lib/db";

const SKIP = new Set(["otp"]);

async function main() {
  const keys = Object.keys(db as object)
    .filter((k) => !k.startsWith("$") && !k.startsWith("_"))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((k) => typeof (db as any)[k]?.findMany === "function")
    .filter((k) => !SKIP.has(k))
    .sort();

  const out: Record<string, unknown[]> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const k of keys) out[k] = await (db as any)[k].findMany();

  const snap = {
    app: "fabricfold", version: 2, takenAt: new Date().toISOString(),
    tables: keys.length, skipped: [...SKIP],
    counts: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])),
    data: out,
  };
  const name = process.argv[2] || "snapshot.json";
  fs.writeFileSync(name, JSON.stringify(snap));
  console.log(`wrote ${name}: ${keys.length} tables, ${Object.values(out).reduce((a, v) => a + v.length, 0)} rows`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
