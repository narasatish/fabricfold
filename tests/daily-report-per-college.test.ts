/* The owner's daily email must show each college on its own (they are two
   businesses), not only one combined total. Runs the real function against the
   dev database (read-only) and checks a block exists per active college. */
import "dotenv/config";
import { describe, expect, it } from "vitest";
import { dailyEmailReport } from "../lib/report";
import { db } from "../lib/db";

describe("daily report per college", () => {
  it("keeps the combined view and adds one block per active college", async () => {
    const text = await dailyEmailReport();
    expect(text).toMatch(/Daily Report/);
    expect(text).toMatch(/RIGHT NOW/); // combined view unchanged
    const colleges = await db.college.findMany({ where: { active: true }, select: { name: true } });
    for (const c of colleges) expect(text).toContain(`━━ ${c.name.toUpperCase()} ━━`);
    expect(text.split("Expected in drawer").length - 1).toBe(colleges.length);
  }, 60_000);
});
