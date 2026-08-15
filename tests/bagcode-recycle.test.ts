/* Recycling customer IDs.

   A bag code is the student's customer ID, printed on a physical bag. It is
   reused when a student leaves — which is a deliberate reversal of the old
   "never reused" rule, so the boundaries are pinned here. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { allocateBagCode, formatBagCode, parseBagCode, bagKindFor } from "../lib/bagcode";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");

/** Minimal stand-in for the slice of Prisma that allocateBagCode touches. */
function fakeTx(bags: { code: string; status: string }[], seq: Record<string, number> = {}) {
  return {
    bag: {
      findMany: async ({ where, orderBy }: never | any) => {
        const letter: string = where.code.startsWith;
        let rows = bags.filter((b) => b.code.startsWith(letter));
        rows = where.status?.not
          ? rows.filter((b) => b.status !== where.status.not)
          : rows.filter((b) => b.status === where.status);
        if (orderBy) rows = [...rows].sort((a, b) => a.code.localeCompare(b.code));
        return rows.map((b) => ({ code: b.code }));
      },
    },
    fySequence: {
      upsert: async ({ where }: any) => {
        const k = where.kind_fyTag.fyTag;
        seq[k] = (seq[k] ?? 0) + 1;
        return { value: seq[k] };
      },
    },
  } as never;
}

describe("allocation prefers released codes", () => {
  it("mints a fresh number when nothing has been released", async () => {
    expect(await allocateBagCode(fakeTx([]), "bronze")).toBe("B001");
  });

  it("reuses a released code instead of minting a new one", async () => {
    const tx = fakeTx([{ code: "B004", status: "released" }], { B: 9 });
    expect(await allocateBagCode(tx, "bronze")).toBe("B004");
  });

  it("hands back the LOWEST released code first", async () => {
    // printed stock comes back in no particular order; numbering should stay dense
    const tx = fakeTx([
      { code: "B012", status: "released" },
      { code: "B003", status: "released" },
      { code: "B007", status: "released" },
    ]);
    expect(await allocateBagCode(tx, "bronze")).toBe("B003");
  });

  it("will not reissue a released code that has since been taken again", async () => {
    // released once, already handed to somebody else — not free any more
    const tx = fakeTx([
      { code: "B002", status: "released" },
      { code: "B002", status: "active" },
    ], { B: 5 });
    expect(await allocateBagCode(tx, "bronze")).toBe("B006");
  });

  it("never reuses a LOST code", async () => {
    // a lost bag turns up later and must still name the student it was issued to
    const tx = fakeTx([{ code: "B001", status: "lost" }], { B: 1 });
    expect(await allocateBagCode(tx, "bronze")).toBe("B002");
  });

  it("never reuses a REPLACED code", async () => {
    const tx = fakeTx([{ code: "B001", status: "replaced" }], { B: 1 });
    expect(await allocateBagCode(tx, "bronze")).toBe("B002");
  });

  it("keeps tiers in separate pools", async () => {
    // a released Bronze code must not be handed out as a Gold one
    const tx = fakeTx([{ code: "B003", status: "released" }]);
    expect(await allocateBagCode(tx, "gold")).toBe("G001");
  });

  it("recycles walk-in codes too", async () => {
    const tx = fakeTx([{ code: "W002", status: "released" }], { W: 8 });
    expect(await allocateBagCode(tx, "walkin")).toBe("W002");
  });
});

describe("code format is unchanged by recycling", () => {
  it("round-trips", () => {
    expect(parseBagCode(formatBagCode("silver", 42)!)).toEqual({ kind: "silver", n: 42 });
  });
  it("tier drives the letter, no plan means walk-in", () => {
    expect(bagKindFor("gold")).toBe("gold");
    expect(bagKindFor(null)).toBe("walkin");
  });
});

describe("release is guarded", () => {
  const src = read("lib/actions/bags.ts");

  it("is Manager+, not counter staff", () => {
    const fn = src.slice(src.indexOf("export async function releaseBagCode"));
    expect(fn).toMatch(/requireStaff\(2\)/);
  });

  it("refuses while the student still has an active plan", () => {
    expect(src).toMatch(/still has an active plan/);
  });

  it("refuses while orders are still open", () => {
    expect(src).toMatch(/still open for this student/);
  });

  it("records when the code was freed, and audits it", () => {
    expect(src).toMatch(/releasedAt: new Date\(\)/);
    expect(src).toMatch(/audit\("Customer ID released"/);
  });

  it("retiring a bag does NOT release the code", () => {
    const retire = src.slice(src.indexOf("export async function retireBag"));
    expect(retire).not.toMatch(/status: "released"/);
    expect(retire).not.toMatch(/releasedAt/);
  });

  it("staff can reach it, and it is not confusable with lost/replaced", () => {
    // an action with no button is a feature nobody has
    const ui = read("app/s/customers/[id]/_components/CustomerClient.tsx");
    expect(ui).toMatch(/releaseBagCode/);
    expect(ui).toMatch(/Student left/);
    expect(ui).toMatch(/confirm\(/); // spells out that the code is reissued
    // and the copy tells staff which button keeps the code reserved
    expect(ui).toMatch(/keeps the old one reserved/);
  });
});

describe("the privacy policy matches what is written to the Sheet", () => {
  const policy = read("app/privacy/page.tsx");

  it("names Google as a processor", () => {
    // the live log carries student names; the policy has to say so
    expect(policy).toMatch(/Google Sheets/);
  });

  it("states the fields, including the ones NOT sent", () => {
    expect(policy).toMatch(/name and customer ID/);
    expect(policy).toMatch(/phone number or address/);
  });
});

describe("the database enforces it, not just the allocator", () => {
  const guards = read("scripts/ensure-guards.mjs");

  it("creates a partial unique index over codes still in service", () => {
    // schema is interpolated so the same guard can be installed on ff_test
    expect(guards).toMatch(/CREATE UNIQUE INDEX .*"\$\{SCHEMA\}"\."Bag"\(code\) WHERE status <> 'released'/);
  });

  it("can target the test schema, so the suite tests a real constraint", () => {
    // otherwise "the DB rejects a duplicate" passes only where nobody runs it
    expect(guards).toMatch(/FF_GUARD_SCHEMA \|\| "public"/);
  });

  it("reports duplicates rather than failing the deploy", () => {
    expect(guards).toMatch(/index NOT added, investigate/);
  });
});
