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
   - a LOST bag does not change who the student is. They are handed a fresh bag
     with the SAME number printed on it, because an ID that changes whenever
     someone mislays a bag is not an identity. The old row stays, marked lost,
     so the history shows what happened. Consequence, accepted: if the lost bag
     is handed in later, two bags carry that number — destroy the found one.
   - a PLAN CHANGE does change the code, because the letter tells staff the
     entitlement, and B on a Gold plan would be a lie.
   - one code never names two students AT ONCE — enforced in the database by a
     partial unique index over ACTIVE bags, not merely by this allocator.
   - globally unique rather than per-campus: whoever finds a bag labelled B042
     must be able to reach exactly one student without knowing the campus. 999
     per kind is a deliberate "for now" ceiling — a second campus needs a campus
     letter in the prefix, and that decision has to happen BEFORE bags print.

   Backed by the same transactional FySequence table as invoice numbering, so
   two counters issuing bags in the same instant cannot collide. */
import type { Prisma } from "./generated/prisma/client";

export const TIERS = ["bronze", "silver", "gold"] as const;
export type Tier = (typeof TIERS)[number];

/** Subscribed students get their tier's letter; non-subscribers "walkin";
    college FACULTY get their own F series (Sep 2026) — they buy cycle packs
    rather than tiered plans, so no tier letter fits them, and the counter
    needs to see at a glance that a bag belongs to a teacher. */
export type BagKind = Tier | "walkin" | "faculty";

export const BAG_LETTER: Record<BagKind, string> = { bronze: "B", silver: "S", gold: "G", walkin: "W", faculty: "F" };
export const BAG_LABEL: Record<BagKind, string> = { bronze: "Bronze", silver: "Silver", gold: "Gold", walkin: "Walk-in", faculty: "Faculty" };

/** Highest sequence a single kind can issue before the scheme needs widening.

    Widened from 999 (Sep 2026): the owner's printed stock is numbered from
    1000 (B1001, G1002…), so the ceiling moved to four digits. Three-digit
    codes already in the database stay valid — a printed bag is never
    invalidated by a numbering change. */
export const MAX_PER_KIND = 9999;

/** New codes START here, because 1000-series bags are what is physically
    printed. The 1–999 range is reserved for codes that already exist. */
export const MINT_FROM = 1000;

/** Start warning here. Running out is not recoverable at the counter — bags are
    printed in advance — so the Owner needs lead time, not a surprise error. */
export const WARN_AT = 9900;

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

/** "bronze", 42 → "B042"; "gold", 1002 → "G1002". Three digits below 1000
    (matching bags already printed that way), plain number above. */
export function formatBagCode(kind: BagKind, n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > MAX_PER_KIND) return null;
  return BAG_LETTER[kind] + (n < 1000 ? String(n).padStart(3, "0") : String(n));
}

/** "B042" or "G1002" → { kind, n }. Null for anything malformed. */
export function parseBagCode(code: string): { kind: BagKind; n: number } | null {
  /* A 4-digit code may not lead with 0: "B0001" is a mistyping of B001, and
     a parser that guesses which code a smudge meant will one day hand a bag
     to the wrong student. Canonical forms only. */
  const m = /^([BSGWF])(\d{3}|[1-9]\d{3})$/.exec((code || "").trim().toUpperCase());
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

  /* Sequence starts at MINT_FROM: printed stock is numbered from 1000, and a
     freshly minted B037 would clash with nothing in the database while
     matching no bag anyone can hold. An existing sequence below that (from
     the 3-digit era) jumps forward once and never looks back. */
  let row = await tx.fySequence.upsert({
    where: { kind_fyTag: { kind: "bagcode", fyTag: letter } },
    create: { kind: "bagcode", fyTag: letter, value: MINT_FROM },
    update: { value: { increment: 1 } },
  });
  if (row.value < MINT_FROM) {
    row = await tx.fySequence.update({
      where: { kind_fyTag: { kind: "bagcode", fyTag: letter } },
      data: { value: MINT_FROM },
    });
  }
  const code = formatBagCode(kind, row.value);
  if (!code) {
    throw new Error(
      `All ${MAX_PER_KIND} ${BAG_LABEL[kind]} bag codes are in use — release codes from students who have left, or widen the code scheme.`,
    );
  }
  return code;
}
