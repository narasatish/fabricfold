/* prisma/seed.ts wipes tables (no transaction) before inserting demo people.
   Found 2026-09-21: pointed at production it would delete complaints,
   notifications, credit history and compensations before the ledger triggers
   stopped it, and README's deploy steps told the reader to run it. It now
   refuses production-looking targets BEFORE connecting. Only refusals are
   tested here — an "allowed" case would genuinely wipe a database. The fake
   hosts below don't exist, so a refusal that failed to trigger would surface
   as a connection error, not "Refusing to seed". */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

const cwd = path.resolve(__dirname, "..");
const runSeed = (env: Record<string, string>) =>
  spawnSync("npx", ["tsx", "prisma/seed.ts"], { cwd, env: { ...process.env, ...env }, encoding: "utf8", shell: true, timeout: 60_000 });

describe("seed refuses production-looking targets", () => {
  it("Render's internal dpg-… host", () => {
    const r = runSeed({ DATABASE_URL: "postgresql://u:p@dpg-abc123-a/db" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Refusing to seed/);
  });

  it("a *.render.com external host", () => {
    const r = runSeed({ DATABASE_URL: "postgresql://u:p@dpg-abc123-a.singapore-postgres.render.com/db" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Refusing to seed/);
  });

  it("NODE_ENV=production, whatever the host", () => {
    const r = runSeed({ DATABASE_URL: "postgresql://u:p@example.invalid/db", NODE_ENV: "production" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Refusing to seed/);
  });
});
