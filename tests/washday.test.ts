/* Wash-day allocation tests â€” proves the round-robin spread and the pure
   off-day check, against the isolated ff_test schema. */
import "dotenv/config";
import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { ensureTestSchema } from "./_schema";
import path from "node:path";

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_URL = IS_PG ? BASE.split("?")[0] + "?schema=ff_test" : "file:" + path.resolve(__dirname, "../test.db");
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let assignWashDay: typeof import("../lib/washday-server").assignWashDay;
let washDayDistribution: typeof import("../lib/washday-server").washDayDistribution;
let isOffWashDay: typeof import("../lib/washday").isOffWashDay;

let n = 0;
const nextPhone = () => `88888${String(++n).padStart(5, "0")}`;
const nextId = () => `wd${String(n).padStart(4, "0")}`;

beforeAll(async () => {
  db = (await import("../lib/db")).db;
  // conditional, shared â€” see tests/_schema.ts for why five parallel pushes
  // were producing three different intermittent failures
  await ensureTestSchema(TEST_URL, async () => {
    try { await db.sheetOutbox.count(); return true; } catch { return false; }
  });
  ({ assignWashDay, washDayDistribution } = await import("../lib/washday-server"));
  ({ isOffWashDay } = await import("../lib/washday"));
  // `prisma db push` against a remote Postgres is the slow part here, and it
  // grows with the schema â€” it sat right on the old 120s budget once the Bag
  // table landed, so this hook needs real headroom, not a tight bound.
}, 300_000);

afterEach(async () => {
  // The remote pooler occasionally drops an idle connection during a long run,
  // which surfaced as an unrelated PURE test failing inside this cleanup. Retry
  // once so a dropped socket doesn't fail a passing test â€” a genuine problem
  // still throws on the second attempt rather than being swallowed.
  const purge = async () => {
    await db.student.deleteMany({ where: { id: { startsWith: "wd" } } });
    await db.college.deleteMany({ where: { id: { startsWith: "wdcol" } } });
  };
  try {
    await purge();
  } catch {
    await purge();
  }
});

async function mkCollege(closedWeekday: number | null) {
  const id = `wdcol${n}`;
  return db.college.create({ data: { id, name: "Wash Day College " + n, closedWeekday, features: {} } });
}
async function mkStudent(collegeId: string, washDay: number | null = null) {
  const id = nextId(), phone = nextPhone();
  return db.student.create({ data: { id, phone, name: "Test " + id, collegeId, washDay } });
}

describe("wash-day allocation spreads students evenly", () => {
  it("assigns the least-loaded open weekday, not a fixed day", async () => {
    const col = await mkCollege(null);
    // stack up Monday(1) and Tuesday(2) artificially, leaving Sunday(0) empty
    for (let i = 0; i < 5; i++) await mkStudent(col.id, 1);
    for (let i = 0; i < 3; i++) await mkStudent(col.id, 2);

    const newStudent = await mkStudent(col.id);
    const assigned = await assignWashDay(newStudent.id, col.id);

    // Sunday (0) has 0 students, far below Monday/Tuesday â€” must win
    expect(assigned).toBe(0);
    const fresh = await db.student.findUnique({ where: { id: newStudent.id } });
    expect(fresh?.washDay).toBe(0);
  });

  it("never assigns the college's closed weekday", async () => {
    const col = await mkCollege(4); // Thursday closed
    for (let i = 0; i < 30; i++) {
      const s = await mkStudent(col.id);
      const day = await assignWashDay(s.id, col.id);
      expect(day).not.toBe(4);
    }
  }, 60_000);

  it("self-corrects toward equal spread as more students are added", async () => {
    const col = await mkCollege(4); // Thursday closed, 6 open days
    /* 30 rather than 60.

       The property is "every open day ends up with exactly the same count",
       and it holds at any multiple of six â€” 60 proved nothing that 30 does
       not. What 60 did do was double the round-trips to a remote database:
       assignWashDay reads the current distribution before each write, so the
       calls cannot be batched, and 120 sequential round-trips overran the 90s
       budget whenever the rest of the suite was competing for the connection.
       It failed in the full run and passed alone, which is the signature of a
       timeout rather than a wrong answer. Halved, and given real headroom. */
    const PER_DAY = 5, OPEN_DAYS = 6;
    for (let i = 0; i < PER_DAY * OPEN_DAYS; i++) {
      const s = await mkStudent(col.id);
      await assignWashDay(s.id, col.id);
    }
    const dist = await washDayDistribution(col.id);
    // deterministic least-loaded assignment â€” no randomness, so this is exact
    for (let d = 0; d < 7; d++) {
      if (d === 4) expect(dist[d]).toBe(0);
      else expect(dist[d]).toBe(PER_DAY);
    }
  }, 180_000);

  it("does not care about total headcount â€” the same logic works for 6 or 600", async () => {
    const small = await mkCollege(null);
    for (let i = 0; i < 6; i++) {
      const s = await mkStudent(small.id);
      await assignWashDay(s.id, small.id);
    }
    const dist = await washDayDistribution(small.id);
    expect(dist.reduce((a, b) => a + b, 0)).toBe(6);
    expect(Math.max(...dist) - Math.min(...dist)).toBeLessThanOrEqual(1);
  });
});

describe("isOffWashDay â€” pure, no DB", () => {
  it("null washDay is never 'off' (unassigned students aren't flagged)", () => {
    expect(isOffWashDay(null)).toBe(false);
  });

  it("flags when today's IST weekday differs from the assigned day", () => {
    // 2026-07-27 is a Monday; IST offset baked into isOffWashDay
    const monday = new Date("2026-07-27T06:00:00Z"); // ~11:30 IST Monday
    expect(isOffWashDay(1, monday)).toBe(false); // assigned Monday, is Monday
    expect(isOffWashDay(2, monday)).toBe(true); // assigned Tuesday, is Monday
  });
});
