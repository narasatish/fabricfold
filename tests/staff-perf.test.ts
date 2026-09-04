/* Queries bounded by the REQUEST, not by how much history the business has.

   Three screens read more the longer FabricFold runs. None of it shows today;
   all of it shows at 5,000 students and 50,000 orders, as staff screens that
   get slower month by month and no single change to blame. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const home = read("app/s/page.tsx");
const homeUi = read("app/s/_components/HomeClient.tsx");
const reports = read("app/s/reports/page.tsx");
const complaints = read("app/s/complaints/page.tsx");
const students = read("lib/actions/students.ts");
const schema = read("prisma/schema.prisma");

describe("staff home no longer ships the student table", () => {
  it("does not fetch every student", () => {
    // it went to the browser purely so the browser could filter it to ten
    expect(home).not.toMatch(/db\.student\.findMany\(\{ select: \{ id: true, name: true, phone: true \} \}\)/);
    expect(home).not.toMatch(/students=\{students\}/);
  });
  it("searches on the server instead", () => {
    expect(students).toMatch(/export async function searchStudents/);
    expect(homeUi).toMatch(/await searchStudents\(q\)/);
  });
  it("still counts new students by an aggregate, not a full-row fetch", () => {
    // groupBy (per-campus breakdown) replaced count(), but it's still the
    // database doing the counting — not a findMany shipping whole rows over.
    expect(home).toMatch(/db\.student\.groupBy\(\{ by: \["collegeId"\], where: \{ createdAt/);
    expect(home).not.toMatch(/db\.student\.findMany\(\{ where: \{ createdAt/);
  });
});

describe("the search action is bounded and guarded", () => {
  const fn = students.slice(students.indexOf("export async function searchStudents"));
  it("requires staff", () => {
    expect(fn).toMatch(/await requireStaff\(1\)/);
  });
  it("caps what it returns", () => {
    expect(fn).toMatch(/take: 20/);
  });
  it("ignores one-character queries", () => {
    // a single letter matches most of the campus and means nothing
    expect(fn).toMatch(/if \(q\.length < 2\) return \{ ok: true as const, students: \[\] \}/);
  });
  it("matches id, phone and name", () => {
    expect(fn).toMatch(/id: \{ contains: q \}/);
    expect(fn).toMatch(/phone: \{ contains/);
    expect(fn).toMatch(/name: \{ contains: q, mode: "insensitive" \}/);
  });
});

describe("typing is debounced and can't show stale results", () => {
  it("waits before querying", () => {
    expect(homeUi).toMatch(/setTimeout\(async \(\) => \{[\s\S]{0,220}\}, 250\)/);
  });
  it("drops a slow response that a newer query has already replaced", () => {
    /* Without this, typing "raj" then "ravi" can end with raj's results on
       screen if the first query returns second. */
    expect(homeUi).toMatch(/const seq = \+\+searchSeq\.current/);
    expect(homeUi).toMatch(/if \(seq === searchSeq\.current && r\.ok\)/);
  });
  it("clears results when the box is emptied", () => {
    expect(homeUi).toMatch(/if \(!q\) \{ setFoundStudents\(\[\]\); return; \}/);
  });
});

describe("reports aggregates in the database", () => {
  it("no longer reads every order", () => {
    expect(reports).not.toMatch(/db\.order\.findMany\(\{ select: \{ studentId: true/);
  });
  it("groups by student and sums server-side", () => {
    expect(reports).toMatch(/db\.order\.groupBy\(\{ by: \["studentId"\]/);
    expect(reports).toMatch(/db\.order\.aggregate\(\{ _sum: \{ total: true \}/);
  });
  it("drops the value that was computed and never shown", () => {
    // subRevenue was assigned and then never referenced again
    expect(reports).not.toMatch(/const subRevenue =/);
  });
  it("uses Prisma aggregates, not Postgres-only raw SQL", () => {
    // the money suite still has a SQLite fallback; `FILTER (WHERE …)` is PG-only
    expect(reports).not.toMatch(/\$queryRaw/);
  });
});

describe("one refresh timer per screen, not two", () => {
  it("the staff layout owns the timer", () => {
    expect(read("app/s/layout.tsx")).toMatch(/<RealtimeRefresh intervalMs=\{10000\} \/>/);
  });
  it.each([["reports", reports], ["complaints", complaints]])(
    "%s does not mount a second one",
    (_name, src) => {
      expect(src).not.toMatch(/<RealtimeRefresh/);
      expect(src).not.toMatch(/RealtimeRefresh \} from/);
    },
  );
});

describe("the N+1 on pending subscriptions is gone", () => {
  it("fetches every pending code in one query", () => {
    expect(home).not.toMatch(/db\.otp\.findFirst/);
    expect(home).toMatch(/db\.otp\.findMany\(\{[\s\S]{0,160}refId: \{ in: pending\.map/);
  });
  it("skips the query entirely when nothing is pending", () => {
    expect(home).toMatch(/pending\.length\s*\n?\s*\? await db\.otp\.findMany/);
  });
});

describe("the indexes the queries actually need", () => {
  const student = schema.slice(schema.indexOf("model Student"), schema.indexOf("model Staff"));
  const payment = schema.slice(schema.indexOf("model Payment"), schema.indexOf("model Invoice"));
  it("Student is indexed at all — it had none", () => {
    expect(student).toMatch(/@@index\(\[collegeId\]\)/);
    expect(student).toMatch(/@@index\(\[createdAt\]\)/);
  });
  it("Payment can serve a filter on `at` alone", () => {
    /* [collegeId, at] leads with collegeId, so the 8-week revenue query —
       which filters only on `at` — could not use it. */
    expect(payment).toMatch(/@@index\(\[at\]\)/);
  });
});
