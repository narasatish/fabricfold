/* Restore a backup snapshot into a database.

   An untested backup is a guess. This is the other half of app/api/backup:
   it reads a snapshot JSON and loads it back, in dependency order so foreign
   keys resolve, and refuses to touch anything that isn't clearly a scratch
   target unless forced.

   Run:
     npx tsx scripts/restore-backup.ts <snapshot.json>            # dry run
     npx tsx scripts/restore-backup.ts <snapshot.json> --apply    # write
     ... --schema=ff_restore_test                                 # target schema

   Refuses `public` without --force-public, because restoring over a live
   database is exactly the mistake that turns a bad day into a catastrophe. */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const file = process.argv.find((a) => a.endsWith(".json"));
const APPLY = process.argv.includes("--apply");
const FORCE_PUBLIC = process.argv.includes("--force-public");
const schemaArg = process.argv.find((a) => a.startsWith("--schema="));
const SCHEMA = schemaArg ? schemaArg.split("=")[1] : "ff_restore_test";

/* Parents before children. Anything not listed loads afterwards in file order,
   so a new table doesn't silently break the restore — it just goes last. */
const ORDER = [
  "appConfig", "college", "plan", "slotWindow", "staff", "student",
  "subscription", "bag", "order", "orderEvent", "garmentTag", "cycleUse",
  "payment", "invoice", "creditNote", "fySequence", "creditUse", "compensation",
  "expense", "payslip", "attendance", "dayClose", "complaint", "complaintMessage",
  "notification", "auditLog", "errorLog", "pushSubscription",
];

async function main() {
  if (!file) { console.error("Pass a snapshot .json path."); process.exit(1); }
  if (SCHEMA === "public" && !FORCE_PUBLIC) {
    console.error("Refusing to restore into `public` without --force-public.");
    process.exit(1);
  }

  const snap = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  const data: Record<string, unknown[]> = snap.data || {};
  console.log(`snapshot : ${path.basename(file)}`);
  console.log(`taken    : ${snap.takenAt}  (v${snap.version})`);
  console.log(`tables   : ${Object.keys(data).length}`);
  console.log(`rows     : ${Object.values(data).reduce((a, v) => a + v.length, 0)}`);
  console.log(`target   : schema "${SCHEMA}"`);
  console.log(APPLY ? "mode     : APPLYING\n" : "mode     : DRY RUN (pass --apply)\n");

  const known = new Set(ORDER);
  const tables = [...ORDER.filter((t) => t in data), ...Object.keys(data).filter((t) => !known.has(t))];
  for (const t of tables) console.log(`  ${t.padEnd(20)} ${String(data[t].length).padStart(5)} rows`);
  if (!APPLY) { console.log("\nDry run — nothing written."); return; }

  const base = (process.env.DIRECT_URL || process.env.DATABASE_URL || "").split("?")[0];
  const target = `${base}?schema=${SCHEMA}`;

  // Build the target schema from the CURRENT Prisma schema, exactly as a real
  // disaster recovery would: fresh database, then load the snapshot.
  console.log(`\nbuilding schema "${SCHEMA}" …`);
  execSync(`npx prisma db push --url "${target}"`, { stdio: "inherit", cwd: path.resolve(__dirname, "..") });

  /* `?schema=` is a Prisma-ENGINE convention that the pg driver adapter does
     NOT honour — it connects to `public` regardless. The first version of this
     script did precisely that: wrote to public, where every row already
     existed, and skipDuplicates swallowed the lot. It reported a clean restore
     having moved nothing; against an empty public it would have written the
     snapshot straight into production. search_path must be set on the
     connection itself, and then confirmed. */
  process.env.DATABASE_URL = target;
  const { PrismaClient } = await import("../lib/generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  /* The schema goes in PrismaPg's SECOND argument. A connection-level
     search_path is not enough: Prisma qualifies generated SQL itself, so with
     only search_path set it still emitted public."College" and wrote to the
     live schema. lib/db.ts already had this right — worth reading the codebase
     before inventing a mechanism. */
  const rdb = new PrismaClient({
    adapter: new PrismaPg({ connectionString: base }, { schema: SCHEMA }),
  });

  // Prove we are writing where we think, before a single row moves: count a
  // table that the target should have and the live schema definitely does.
  const preexisting = await rdb.college.count();
  console.log(`target schema "${SCHEMA}" currently holds ${preexisting} college row(s)`);
  if (preexisting > 0) {
    console.error(
      `Refusing: "${SCHEMA}" is not empty. A restore must run into a clean schema,\n` +
        `otherwise a partial load looks like a success. Drop it first:\n` +
        `  npx tsx scripts/drop-schema.ts ${SCHEMA}`,
    );
    await rdb.$disconnect();
    process.exit(1);
  }

  let loaded = 0;
  const failures: string[] = [];
  for (const t of tables) {
    const rows = data[t];
    if (!rows?.length) continue;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const delegate = (rdb as any)[t];
      if (!delegate?.createMany) { failures.push(`${t}: no such model in the current schema`); continue; }
      // NO skipDuplicates: a duplicate while restoring into a fresh schema
      // means something is wrong and must be heard, not swallowed.
      const r = await delegate.createMany({ data: rows });
      const n = r.count ?? 0;
      loaded += n;
      if (n !== rows.length) failures.push(`${t}: expected ${rows.length} rows, inserted ${n}`);
      console.log(`  ${t.padEnd(20)} loaded ${n}/${rows.length}`);
    } catch (e) {
      failures.push(`${t}: ${(e as Error).message.split("\n")[0].slice(0, 90)}`);
    }
  }

  /* Read back and compare. "createMany returned a number" is not proof the data
     is there — confirming the rows can be read afterwards is the entire point
     of testing a restore. */
  console.log("\nverifying by re-reading each table …");
  for (const t of tables) {
    const expected = data[t]?.length ?? 0;
    if (!expected) continue;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const actual = await (rdb as any)[t].count();
      if (actual !== expected) failures.push(`${t}: read back ${actual}, expected ${expected}`);
    } catch (e) {
      failures.push(`${t}: could not read back — ${(e as Error).message.slice(0, 60)}`);
    }
  }

  console.log(`\nloaded ${loaded} rows into "${SCHEMA}"`);
  if (failures.length) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log("  ✗", f);
    process.exitCode = 1;
  } else {
    console.log("✓ every table restored without error");
  }
  await rdb.$disconnect();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
