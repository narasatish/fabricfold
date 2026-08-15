/* Codes printed on the physical bags handed to students.

   B001–B999 bronze · S001–S999 silver · G001–G999 gold · W001–W999 walk-in
   (a student with no subscription who buys a bag).

   The code IS the student's customer ID: printed on the bag, permanent for as
   long as they hold it, and quoted at the counter.

   The code names a physical object, so the rules are strict:
   - RECYCLED, but only deliberately. When a student graduates, staff release
     their code and it returns to the pool for a new student — otherwise 999
     per tier would be a hard ceiling on how many students the campus can ever
     enrol. Reuse happens only through that explicit release.
   - a lost bag keeps its code reserved forever. Bags turn up weeks later, and
     a found B042 must still name the person it was issued to rather than
     whoever inherited the number. Same for a bag replaced on a plan change.
   - one code never names two students AT ONCE — enforced in the database by a
     partial unique index, not merely by this allocator.
   - globally unique rather than per-campus: whoever finds a bag labelled B042
     must be able to reach exactly one student without knowing the campus. 999
     per kind is a deliberate "for now" ceiling — a second campus needs a campus
     letter in the prefix, and that decision has to happen BEFORE bags print.

   Backed by the same transactional FySequence table as invoice numbering, so
   two counters issuing bags in the same instant cannot collide. */
import type { Prisma } from "./generated/prisma/client";

export const TIERS = ["bronze", "silver", "gold"] as const;
export type Tier = (typeof TIERS)[number];

/** Subscribed students get their tier's letter; everyone else gets "walkin". */
export type BagKind = Tier | "walkin";

export const BAG_LETTER: Record<BagKind, string> = { bronze: "B", silver: "S", gold: "G", walkin: "W" };
export const BAG_LABEL: Record<BagKind, string> = { bronze: "Bronze", silver: "Silver", gold: "Gold", walkin: "Walk-in" };

/** Highest sequence a single kind can issue before the scheme needs widening. */
export const MAX_PER_KIND = 999;

/** Start warning here. Running out is not recoverable at the counter — bags are
    printed in advance — so the Owner needs lead time, not a surprise error. */
export const WARN_AT = 900;

export function codesRemaining(lastIssued: number) {
  return Math.max(0, MAX_PER_KIND - lastIssued);
}

export function isTier(v: unknown): v is Tier {
  return typeof v === "string" && (TIERS as readonly string[]).includes(v);
}

/** A plan tier if there is one, otherwise the walk-in kind. */
export function bagKindFor(tier: string | null | undefined): BagKind {
  return isTier(tier) ? tier : "walkin";
}

/** "bronze", 42 → "B042". Null when the number is outside 1..999. */
export function formatBagCode(kind: BagKind, n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > MAX_PER_KIND) return null;
  return BAG_LETTER[kind] + String(n).padStart(3, "0");
}

/** "B042" → { kind: "bronze", n: 42 }. Null for anything malformed. */
export function parseBagCode(code: string): { kind: BagKind; n: number } | null {
  const m = /^([BSGW])(\d{3})$/.exec((code || "").trim().toUpperCase());
  if (!m) return null;
  const kinds = Object.keys(BAG_LETTER) as BagKind[];
  const kind = kinds.find((k) => BAG_LETTER[k] === m[1]);
  const n = Number(m[2]);
  if (!kind || n < 1 || n > MAX_PER_KIND) return null;
  return { kind, n };
}

/** Claim a code for a kind. Call inside the transaction that creates the Bag
    row, so a rolled-back handover doesn't burn a code.

    Released codes are reused BEFORE minting a new number, and the lowest one
    goes first. Two reasons: the printed stock is reused in the order it comes
    back, and the numbers stay dense — a campus of 300 students should be
    holding B001–B300, not drifting toward B999 with gaps where graduates were. */
export async function allocateBagCode(tx: Prisma.TransactionClient, kind: BagKind) {
  const letter = BAG_LETTER[kind];

  /* A code is free when some bag row released it and no LIVE row holds it.
     Both halves are needed: a code can be released once and later re-issued,
     so the released row alone doesn't prove it is available now. */
  const [released, live] = await Promise.all([
    tx.bag.findMany({
      where: { status: "released", code: { startsWith: letter } },
      select: { code: true },
      orderBy: { code: "asc" },
    }),
    tx.bag.findMany({
      where: { status: { not: "released" }, code: { startsWith: letter } },
      select: { code: true },
    }),
  ]);
  const taken = new Set(live.map((b) => b.code));
  const recycled = released.find((r) => !taken.has(r.code));
  if (recycled) return recycled.code;

  const row = await tx.fySequence.upsert({
    where: { kind_fyTag: { kind: "bagcode", fyTag: letter } },
    create: { kind: "bagcode", fyTag: letter, value: 1 },
    update: { value: { increment: 1 } },
  });
  const code = formatBagCode(kind, row.value);
  if (!code) {
    throw new Error(
      `All ${MAX_PER_KIND} ${BAG_LABEL[kind]} bag codes are in use — release codes from students who have left, or widen the code scheme.`,
    );
  }
  return code;
}
