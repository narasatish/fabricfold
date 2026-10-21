/* scripts/check-backup-coverage.ts is the safety net that is supposed to
   catch a Prisma model silently missing from the backup route (app/api/
   backup/route.ts's own file-header comment documents a real incident: Plan,
   Bag, DayClose, Attendance and SlotWindow were all absent from a prior
   hand-maintained `const TABLES = [...] as const` list).

   That route was rewritten (route.ts's own "v2" comment) to derive its table
   list dynamically from the live Prisma client — `backupTables()` — plus a
   `SKIP` set, instead of a hand-maintained `const TABLES` array. The checker
   script was never updated to match: it still regexes route.ts's source text
   for `const TABLES = [...] as const`, which no longer exists. `(route.match
   (...) || [])[1]` is therefore always `undefined`, and the very next line
   calls `.matchAll` on it — the coverage checker itself throws instead of
   reporting coverage, for every model, forever. The exact safety net this
   script exists to be had silently stopped working.

   This test runs the script as a child process (the same way a human or CI
   would invoke it: `npx tsx scripts/check-backup-coverage.ts`) and asserts it
   exits cleanly and reports real coverage, instead of crashing with a
   TypeError. */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(__dirname, "..");

describe("scripts/check-backup-coverage.ts", () => {
  it("runs to completion instead of crashing on route.ts's new dynamic table derivation", () => {
    let out = "";
    let code = 0;
    try {
      out = execFileSync("npx", ["tsx", "scripts/check-backup-coverage.ts"], { cwd: root, encoding: "utf8" });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? 1;
      out = (err.stdout || "") + (err.stderr || "");
    }
    expect(out).not.toMatch(/TypeError/);
    expect(out).toMatch(/every model is covered/);
    expect(code).toBe(0);
  }, 30_000);
});
