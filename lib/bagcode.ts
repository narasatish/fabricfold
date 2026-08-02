/* Codes printed on the physical bags handed to students.

   B001–B999 bronze · S001–S999 silver · G001–G999 gold · W001–W999 walk-in
   (a student with no subscription who buys a bag).

   The code names a physical object, so the rules are strict:
   - allocated exactly once, gap-free, and NEVER reused. A recycled code would
     make one printed bag point at two different students over its lifetime.
   - a lost bag is marked lost and the student gets a NEW code, not the old one.
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

/** Claim the next code for a kind. Call inside the transaction that creates the
    Bag row, so a rolled-back handover doesn't burn a code. */
export async function allocateBagCode(tx: Prisma.TransactionClient, kind: BagKind) {
  const row = await tx.fySequence.upsert({
    where: { kind_fyTag: { kind: "bagcode", fyTag: BAG_LETTER[kind] } },
    create: { kind: "bagcode", fyTag: BAG_LETTER[kind], value: 1 },
    update: { value: { increment: 1 } },
  });
  const code = formatBagCode(kind, row.value);
  if (!code) {
    throw new Error(
      `All ${MAX_PER_KIND} ${BAG_LABEL[kind]} bag codes are used up — widen the code scheme before issuing more.`,
    );
  }
  return code;
}
