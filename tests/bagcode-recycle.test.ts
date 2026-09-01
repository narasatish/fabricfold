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
      /* Mirrors the real allocator's contract: upsert CREATES at MINT_FROM
         (1000) or increments, and update() jumps a legacy 3-digit-era
         sequence forward. */
      upsert: async ({ where, create }: any) => {
        const k = where.kind_fyTag.fyTag;
        seq[k] = seq[k] === undefined ? create.value : seq[k] + 1;
        return { value: seq[k] };
      },
      update: async ({ where, data }: any) => {
        const k = where.kind_fyTag.fyTag;
        seq[k] = data.value;
        return { value: seq[k] };
      },
    },
  } as never;
}

describe("allocation prefers released codes", () => {
  it("mints from 1000 — the printed stock's numbering — when nothing has been released", async () => {
    expect(await allocateBagCode(fakeTx([]), "bronze")).toBe("B1000");
  });

  it("jumps a legacy sub-1000 sequence forward instead of colliding with print stock", async () => {
    // a campus that minted B001–B037 in the 3-digit era must not mint B038
    // once the owner's B1001-numbered bags exist
    const tx = fakeTx([], { B: 37 });
    expect(await allocateBagCode(tx, "bronze")).toBe("B1000");
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
    ], { B: 1004 });
    expect(await allocateBagCode(tx, "bronze")).toBe("B1005");
  });

  it("never hands a LOST code to a different student", async () => {
    /* The owner of a lost code keeps it — they get the same number on a new
       bag, via reissueBagSameCode, which bypasses this allocator entirely.
       What must never happen is the allocator giving that code to somebody else. */
    const tx = fakeTx([{ code: "B1001", status: "lost" }], { B: 1001 });
    expect(await allocateBagCode(tx, "bronze")).toBe("B1002");
  });

  it("never reuses a REPLACED code", async () => {
    const tx = fakeTx([{ code: "B1001", status: "replaced" }], { B: 1001 });
    expect(await allocateBagCode(tx, "bronze")).toBe("B1002");
  });

  it("keeps tiers in separate pools", async () => {
    // a released Bronze code must not be handed out as a Gold one
    const tx = fakeTx([{ code: "B003", status: "released" }]);
    expect(await allocateBagCode(tx, "gold")).toBe("G1000");
  });

  it("recycles walk-in codes too", async () => {
    const tx = fakeTx([{ code: "W002", status: "released" }], { W: 1008 });
    expect(await allocateBagCode(tx, "walkin")).toBe("W002");
  });

  it("accepts the owner's four-digit printed codes", async () => {
    expect(parseBagCode("B1001")).toEqual({ kind: "bronze", n: 1001 });
    expect(parseBagCode("G1100")).toEqual({ kind: "gold", n: 1100 });
    expect(formatBagCode("silver", 1009)).toBe("S1009");
    // and the 3-digit era stays valid — printed bags are never invalidated
    expect(parseBagCode("B042")).toEqual({ kind: "bronze", n: 42 });
    expect(formatBagCode("bronze", 42)).toBe("B042");
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
    expect(ui).toMatch(/confirm\(/); // spells out that the code goes to the pool
    // and the copy says which action frees the code, versus which keeps it
    expect(ui).toMatch(/is the only action that frees/);
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

  it("allows one ACTIVE bag per code, not one row per code", () => {
    /* Changed deliberately. The old rule (one row per non-released code)
       forbade a lost bag and its replacement sharing a number — which is
       exactly what a permanent customer ID requires. */
    expect(guards).toMatch(/CREATE UNIQUE INDEX .*"\$\{SCHEMA\}"\."Bag"\(code\) WHERE status = 'active'/);
    expect(guards).toMatch(/bag_code_one_active_uniq/);
  });

  it("drops the superseded index by name, so the change actually lands", () => {
    // leaving it in place would silently block every reissue
    expect(guards).toMatch(/DROP INDEX IF EXISTS .*bag_code_in_service_uniq/);
  });

  it("can target the test schema, so the suite tests a real constraint", () => {
    // otherwise "the DB rejects a duplicate" passes only where nobody runs it
    expect(guards).toMatch(/FF_GUARD_SCHEMA \|\| "public"/);
  });

  it("reports duplicates rather than failing the deploy", () => {
    expect(guards).toMatch(/index NOT added, investigate/);
  });
});
