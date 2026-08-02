/* Bag codes for subscribed students.

   Every student who buys a plan gets ONE complimentary bag with a code printed
   on it: B001–B999 (bronze), S001–S999 (silver), G001–G999 (gold). The code
   identifies a PHYSICAL object, so the rules are strict:

   - allocated exactly once, at subscription time
   - gap-free and never reused (a returned bag's code is not recycled — the
     printed label would then point at two different students over time)
   - globally unique, not per-college: someone finding a bag labelled B042
     must be able to map it to exactly one student without knowing the campus.
     If FabricFold expands past a few campuses, add a campus letter to the
     prefix — 999 per tier is a deliberate "for now" ceiling.

   Backed by the same transactional FySequence table as invoice numbering, so
   two counters assigning plans at the same instant can't collide. */
import type { Prisma } from "./generated/prisma/client";

export const TIERS = ["bronze", "silver", "gold"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LETTER: Record<Tier, string> = { bronze: "B", silver: "S", gold: "G" };
export const TIER_LABEL: Record<Tier, string> = { bronze: "Bronze", silver: "Silver", gold: "Gold" };

/** Highest sequence number a single tier can issue before the scheme needs widening. */
export const MAX_PER_TIER = 999;

export function isTier(v: unknown): v is Tier {
  return typeof v === "string" && (TIERS as readonly string[]).includes(v);
}

/** "bronze", 42 → "B042". Returns null when the number is outside 1..999. */
export function formatPlanCode(tier: Tier, n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > MAX_PER_TIER) return null;
  return TIER_LETTER[tier] + String(n).padStart(3, "0");
}

/** "B042" → { tier: "bronze", n: 42 }. Null for anything malformed. */
export function parsePlanCode(code: string): { tier: Tier; n: number } | null {
  const m = /^([BSG])(\d{3})$/.exec((code || "").trim().toUpperCase());
  if (!m) return null;
  const tier = (TIERS as readonly Tier[]).find((t) => TIER_LETTER[t] === m[1]);
  const n = Number(m[2]);
  if (!tier || n < 1 || n > MAX_PER_TIER) return null;
  return { tier, n };
}

/** Claim the next code for a tier. Call inside the same transaction that
    creates the subscription, so a rolled-back signup doesn't burn a code. */
export async function allocatePlanCode(tx: Prisma.TransactionClient, tier: Tier) {
  const row = await tx.fySequence.upsert({
    where: { kind_fyTag: { kind: "plancode", fyTag: TIER_LETTER[tier] } },
    create: { kind: "plancode", fyTag: TIER_LETTER[tier], value: 1 },
    update: { value: { increment: 1 } },
  });
  const code = formatPlanCode(tier, row.value);
  if (!code) {
    throw new Error(
      `All ${MAX_PER_TIER} ${TIER_LABEL[tier]} bag codes are used up — widen the code scheme before selling more ${TIER_LABEL[tier]} plans.`,
    );
  }
  return code;
}
