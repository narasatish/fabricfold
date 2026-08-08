/* Does the backup actually cover every table?

   The TABLES list in app/api/backup/route.ts is hand-maintained, so a model
   added to the schema is silently absent from every snapshot until someone
   remembers. A backup you believe in but which omits tables is worse than no
   backup. */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
const route = fs.readFileSync(path.join(root, "app/api/backup/route.ts"), "utf8");

const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
const listed = [...(route.match(/const TABLES = \[([\s\S]*?)\] as const/) || [])[1]
  .matchAll(/"(\w+)"/g)].map((m) => m[1]);

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const covered = new Set(listed);
const missing = models.filter((m) => !covered.has(lower(m)));
const unknown = listed.filter((t) => !models.some((m) => lower(m) === t));

console.log(`models in schema : ${models.length}`);
console.log(`tables backed up : ${listed.length}\n`);
if (missing.length) {
  console.log("NOT BACKED UP:");
  for (const m of missing) console.log("  ✗", m);
} else console.log("every model is covered");
if (unknown.length) {
  console.log("\nlisted but not a model (would crash the backup):");
  for (const u of unknown) console.log("  ?", u);
}
process.exitCode = missing.length || unknown.length ? 1 : 0;
