/* Does the backup actually cover every table?

   app/api/backup/route.ts (and scripts/take-snapshot.ts, which copies the
   same logic) no longer hand-maintain a table list — v2 derives it at
   runtime from every Prisma client delegate that has a `findMany`, minus a
   `SKIP` set (currently just "otp": live login codes, pointless to restore).
   That dynamic approach is exactly what fixed the original incident this
   script exists to catch (Plan, Bag, DayClose, Attendance and SlotWindow
   all silently missing from a prior hand-written list) — a new model is
   covered automatically the day it's added.

   So "every table backed up" is no longer a question of two lists agreeing;
   it reduces to: every model in the schema is either in SKIP, or has a
   working Prisma delegate (so backupTables()'s own `findMany` filter picks
   it up). This checker reads SKIP out of route.ts's source (so a change
   there is still visible here) and loads the real Prisma client to confirm
   each schema model actually resolves to a delegate with `findMany` —
   the same test the runtime filter applies. */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
const route = fs.readFileSync(path.join(root, "app/api/backup/route.ts"), "utf8");

const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
const skipMatch = route.match(/const SKIP = new Set\(\[([\s\S]*?)\]\)/);
if (!skipMatch) {
  console.error("Could not find `const SKIP = new Set([...])` in app/api/backup/route.ts — has it changed shape again?");
  process.exit(1);
}
const skipped = new Set([...skipMatch[1].matchAll(/"(\w+)"/g)].map((m) => m[1]));

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

async function main() {
  const { db } = await import("../lib/db");
  const delegates = new Set(
    Object.keys(db as object)
      .filter((k) => !k.startsWith("$") && !k.startsWith("_"))

      .filter((k) => typeof (db as any)[k]?.findMany === "function"),
  );

  const missing = models.filter((m) => !skipped.has(lower(m)) && !delegates.has(lower(m)));
  const coveredCount = models.length - skipped.size - missing.length;

  console.log(`models in schema : ${models.length}`);
  console.log(`skipped (SKIP)   : ${skipped.size} (${[...skipped].join(", ")})`);
  console.log(`covered          : ${coveredCount}\n`);
  if (missing.length) {
    console.log("NOT BACKED UP (no matching Prisma delegate — backup would silently omit this table):");
    for (const m of missing) console.log("  ✗", m);
  } else console.log("every model is covered");
  process.exitCode = missing.length ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
